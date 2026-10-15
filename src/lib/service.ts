import "server-only";
import Decimal from "decimal.js";
import { createHash } from "node:crypto";
import type { Config } from "./config";
import { BinanceClient } from "./binance";
import { BinanceFuturesClient } from "./binance-futures";
import { demoData, demoHistory } from "./demo";
import { STABLECOINS, totalPnl, valueHoldings, resolveEquity } from "./portfolio";
import { readHistory, saveSnapshot } from "./storage";
import type { Dashboard, ProviderData } from "./types";
import { tradeRealizedPnl } from "./trade-pnl";
import { readCosts } from "./cost-store";
import { closedReview } from "./closed-review";
import { futuresAccounting } from "./futures-pnl";
import { readLedger, saveLedger } from "./ledger-store";
type Cached = { data: ProviderData; time: number };
const cache = new Map<string, Cached>();
const pending = new Map<string, Promise<Cached>>();
async function provider(c: Config, futuresEnabled = false): Promise<Cached> {
  if (c.DATA_SOURCE === "demo") return { data: demoData(), time: Date.now() };
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        c.ACCOUNT_ID,
        c.BINANCE_API_KEY,
        c.BINANCE_API_SECRET,
        c.BINANCE_ENV,
        c.symbols,
        futuresEnabled,
      ]),
    )
    .digest("hex");
  for (const [k, value] of cache) if (Date.now() - value.time >= 30000) cache.delete(k);
  const current = cache.get(key);
  if (current) return current;
  let request = pending.get(key);
  if (!request) {
    request = (async () => {
      let stored: Awaited<ReturnType<typeof readLedger>>;
      let storageFailed = false;
      try {
        stored = await readLedger(c);
      } catch {
        storageFailed = true;
      }
      const [spotResult, futuresResult] = await Promise.allSettled([
        new BinanceClient(c).load(c.symbols, stored?.ledger),
        futuresEnabled
          ? new BinanceFuturesClient(c).loadFutures(stored?.ledger.futures)
          : Promise.resolve(undefined),
      ]);
      if (spotResult.status === "rejected") throw spotResult.reason;
      const data = spotResult.value;
      if (futuresResult.status === "fulfilled" && futuresResult.value) {
        data.futures = futuresResult.value;
        data.warnings.push(...data.futures.warnings);
        if (data.ledger) data.ledger.futures = data.futures.ledger;
      } else if (futuresResult.status === "rejected") {
        data.warnings.push("合约账户暂未读取成功，请检查当前 API 的合约读取权限与 IP 限制。");
      }
      if (data.ledger && !storageFailed) {
        try {
          await saveLedger(c, data.ledger, stored?.revision);
        } catch {
          storageFailed = true;
        }
      }
      if (storageFailed)
        data.warnings.push("成交同步进度未能保存，将在下次刷新重试；请联系管理员检查存储。");
      if (process.env.VERCEL && !c.DATABASE_URL)
        data.warnings.push("历史同步进度暂未启用持久保存，服务重启后可能重新同步；请联系管理员。");
      return data;
    })()
      .then((data) => {
        const result = { data, time: Date.now() };
        cache.set(key, result);
        return result;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}
export async function dashboard(c: Config, persist = false): Promise<Dashboard> {
  const demo = c.DATA_SOURCE === "demo";
  const futuresEnabled = !demo;
  const { data, time } = await provider(c, futuresEnabled);
  const futures = futuresAccounting(futuresEnabled ? data.futures : undefined);
  let costs: Record<string, string> = {};
  let costStorageFailed = false;
  try {
    costs = (await readCosts(c)).costs;
  } catch {
    costStorageFailed = true;
  }
  const accounting = tradeRealizedPnl(data.ledger, data.tradesComplete);
  const spotHoldings = valueHoldings(data.balances, data.tickers, { ...costs, USDT: "1" });
  const sum = (values: (string | null)[]) =>
    values.reduce<Decimal>((a, v) => a.plus(v ?? 0), new Decimal(0)).toString();
  const spotValuation = resolveEquity(spotHoldings, data.spotEquity);
  // Exchange marginBalance already includes unrealized PnL, settled funding, fees and
  // realized gains. Add the two wallets once; never add their holdings/PnL again.
  const futuresEquity = futuresEnabled ? (data.futures?.account?.equity ?? null) : null;
  const valuation = {
    ...spotValuation,
    equity: new Decimal(spotValuation.equity).plus(futuresEquity ?? 0).toString(),
    equityComplete: spotValuation.equityComplete && (!futuresEnabled || futuresEquity !== null),
  };
  const holdings = [...spotHoldings, ...(futuresEnabled ? futures.holdings : [])].map((h) => ({
    ...h,
    allocation: new Decimal(valuation.equity).gt(0)
      ? new Decimal(h.value ?? 0).div(valuation.equity).mul(100).toNumber()
      : 0,
  }));
  const { equity, equityComplete } = valuation;
  const unpriced = holdings.filter((h) => h.value === null).length;
  const baseline = demo ? "100000" : c.PERFORMANCE_BASELINE_USDT;
  const netFlows = demo ? "0" : c.PERFORMANCE_NET_FLOWS_USDT;
  const nonStableHoldings = spotHoldings.filter((h) => !STABLECOINS.has(h.asset));
  const costed = nonStableHoldings.filter((h) => h.unrealizedPnl !== null);
  const cash = spotHoldings.find((h) => h.asset === "USDT");
  const warnings = [...data.warnings, ...(futuresEnabled ? futures.warnings : [])];
  if (futuresEnabled && futuresEquity === null)
    warnings.push("合约账户权益暂未读取，总资产仅显示现货部分，暂不写入资产走势。");
  const combine = (spot: string | null, contract: string | null) =>
    spot === null || (futuresEnabled && contract === null)
      ? null
      : new Decimal(spot).plus(futuresEnabled ? contract! : 0).toString();
  const realizedPnl = combine(accounting.realizedPnl, futures.realizedPnl);
  const realizedPnlComplete = accounting.complete && (!futuresEnabled || futures.complete);
  const holdingPnl = combine(
    costed.length === nonStableHoldings.length ? sum(costed.map((h) => h.unrealizedPnl)) : null,
    futures.holdingPnl,
  );
  let history = demo ? demoHistory(equity) : [];
  let saved = false;
  if (!demo && c.DATABASE_URL) {
    try {
      // Exchange equity remains usable even when individual ticker valuations are missing.
      if (persist && equityComplete) {
        await saveSnapshot(c, { time, equity });
        saved = true;
      }
      history = await readHistory(c);
    } catch {
      warnings.push("历史净值暂时不可用；实时账户数据仍可查看，请联系管理员。");
    }
  }
  if (!demo && !c.DATABASE_URL) warnings.push("历史净值尚未启用，实时账户数据可正常查看。");
  if (unpriced)
    warnings.push(
      equityComplete
        ? `${unpriced} 种资产缺少可用行情，持仓明细估值不完整；现货部分使用交易所钱包估值。`
        : `${unpriced} 种资产缺少可用行情，当前总额仅为已估值资产小计，累计盈亏暂停计算。`,
    );
  const missingCosts = nonStableHoldings.filter((h) => h.averageCost === null).map((h) => h.asset);
  if (costStorageFailed) warnings.push("管理员成本暂时无法读取，未实现盈亏暂停计算，请稍后重试。");
  else if (missingCosts.length)
    warnings.push(
      `尚未设置成本：${missingCosts.join("、")}。请管理员在成本管理中填写平均单位成本。`,
    );
  if (accounting.missingBuys.length)
    warnings.push(
      `已实现盈亏缺少可匹配的历史买入：${accounting.missingBuys.join("、")}。转入资产的取得成本无法从当前成交记录确认。`,
    );
  if (accounting.missingRates.length)
    warnings.push(`已实现盈亏等待手续费历史汇率：${accounting.missingRates.join("、")}。`);
  if (accounting.unsupported)
    warnings.push("成交记录包含非 USDT 交易对，跨币成本尚未核算，暂不显示已实现盈亏总额。");
  warnings.push(
    "已实现盈亏逐笔累计：买入记当笔手续费的负值；卖出记平仓收益减当笔卖出手续费，已扣的买入手续费不再扣除。同步期间显示已读取成交的暂计值，可能随历史补齐调整。手工成本只影响未实现盈亏，转账、闪兑等非成交变动不在此口径内。",
  );
  if (accounting.estimatedFees)
    warnings.push(
      "BNB 等第三币手续费按成交所在分钟的历史收盘价折算 USDT，属于近似折算，不使用当前行情或手工成本。",
    );
  const review = closedReview(data, holdings);
  review.complete &&= !futuresEnabled || data.futures?.tradesComplete === true;
  const combinedTrades = [...data.trades, ...(data.futures?.trades ?? [])].sort(
    (a, b) => b.time - a.time,
  );
  return {
    source: c.DATA_SOURCE,
    accountLabel: c.ACCOUNT_LABEL,
    environment: demo
      ? "演示账户"
      : c.BINANCE_ENV === "testnet"
        ? "Binance Spot Testnet"
        : "Binance Spot",
    updatedAt: time,
    holdings,
    closedReview: review,
    trades: combinedTrades.slice(0, 1000),
    orders: [...data.orders, ...(data.futures?.orders ?? [])],
    history,
    summary: {
      ...valuation,
      pricedAssets: holdings.length - unpriced,
      unpricedAssets: unpriced,
      ...(futuresEnabled
        ? {
            futuresEquity,
            futuresAvailable: data.futures?.account?.availableBalance ?? null,
            futuresFundingPnl: futures.fundingPnl,
          }
        : {}),
      unrealizedPnl: holdingPnl,
      holdingPnlComplete:
        !futuresEnabled || (data.futures?.complete === true && futures.fundingPnl !== null),
      realizedPnl,
      realizedPnlComplete,
      feePnl: combine(accounting.feePnl, futures.feePnl),
      realizedPnlNote:
        realizedPnl !== null
          ? realizedPnlComplete
            ? "按成交核算 · 逐笔计入当笔手续费"
            : "历史同步中 · 已同步成交暂计（含手续费）"
          : [
              ...(futuresEnabled && futures.realizedPnl === null ? ["合约流水待核算"] : []),
              ...(!data.tradesComplete ? ["成交历史同步中"] : []),
              ...(accounting.missingBuys.length
                ? [`缺 ${accounting.missingBuys.join("、")} 历史买入`]
                : []),
              ...(accounting.missingRates.length
                ? [`待补 ${accounting.missingRates.join("、")} 手续费汇率`]
                : []),
              ...(accounting.unsupported ? ["跨币成交待核算"] : []),
            ].join(" · ") || "尚无可核算的成交历史",
      principal: c.PRINCIPAL_USDT ?? (demo ? "100000" : null),
      cash: cash?.quantity ?? "0",
      cashFree: cash?.free ?? "0",
      cashLocked: cash?.locked ?? "0",
      costCoverage: costed.length,
      totalPnl: totalPnl(equity, baseline, netFlows, equityComplete ? 0 : Math.max(1, unpriced)),
      baseline: baseline ?? null,
      baselineAt: demo
        ? new Date(Date.now() - 7 * 86400000).toISOString()
        : (c.PERFORMANCE_BASELINE_AT ?? null),
      netFlows: netFlows ?? null,
      stablecoinValue: sum(
        spotHoldings.filter((h) => STABLECOINS.has(h.asset)).map((h) => h.value),
      ),
      tradeCount: combinedTrades.length,
    },
    connection: {
      futuresEnabled,
      futuresComplete: !futuresEnabled || futures.complete,
      futuresPositionsComplete: !futuresEnabled || data.futures?.positionsComplete === true,
      futuresTradesComplete: !futuresEnabled || data.futures?.tradesComplete === true,
      futuresHistoryStart: data.futures?.ledger.startTime ?? null,
      database: Boolean(c.DATABASE_URL),
      snapshotsSaved: saved,
      symbols: [...new Set(combinedTrades.map((t) => t.symbol))],
      historySync: data.historySync ?? { scanned: 0, total: 0, oldestCheck: null },
      tradesComplete: data.tradesComplete,
      ordersComplete:
        data.ordersComplete && (!futuresEnabled || data.futures?.ordersComplete === true),
    },
    warnings,
  };
}
