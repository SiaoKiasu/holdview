import "server-only";
import { z } from "zod";
import Decimal from "decimal.js";
import { AppError } from "./errors";
import { BinanceClient } from "./binance";
import type { Config } from "./config";
import type { FuturesData, FuturesIncome, FuturesLedger, Trade } from "./types";

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const transactionId = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().safe().transform(String),
]);
const incomeSchema = z.array(
  z.object({
    tranId: transactionId,
    tradeId: z.string().optional(),
    symbol: z.string(),
    incomeType: z.string(),
    income: decimal,
    asset: z.string(),
    time: z.number().int(),
  }),
);
const positionsSchema = z.array(
  z.object({
    symbol: z.string(),
    positionSide: z.enum(["BOTH", "LONG", "SHORT"]),
    positionAmt: decimal,
    entryPrice: decimal,
    markPrice: decimal,
    unRealizedProfit: decimal,
    marginAsset: z.string(),
  }),
);
const accountSchema = z.object({
  totalMarginBalance: decimal,
  assets: z.array(
    z.object({
      asset: z.string(),
      marginBalance: decimal,
      walletBalance: decimal,
      availableBalance: decimal,
      initialMargin: decimal,
    }),
  ),
});
const tradesSchema = z.array(
  z.object({
    id: transactionId,
    symbol: z.string(),
    side: z.enum(["BUY", "SELL"]),
    price: decimal,
    qty: decimal,
    quoteQty: decimal,
    commission: decimal,
    commissionAsset: z.string(),
    time: z.number(),
    maker: z.boolean(),
    realizedPnl: decimal,
    positionSide: z.enum(["BOTH", "LONG", "SHORT"]).optional(),
  }),
);
function reason(error: unknown) {
  if (error instanceof AppError) return error.message;
  if (error instanceof z.ZodError)
    return `返回字段格式异常（${error.issues[0]?.path.join(".") ?? "未知字段"}）`;
  return "请稍后重试";
}
const DAY = 86400000;
export const incomeKey = (i: FuturesIncome) => `${i.incomeType}:${i.tranId}`;
export const incomeRateKey = (i: FuturesIncome) =>
  `${i.asset}:${Math.floor(i.time / 60000) * 60000}`;

export class BinanceFuturesClient extends BinanceClient {
  constructor(
    c: Pick<Config, "BINANCE_ENV" | "BINANCE_API_KEY" | "BINANCE_API_SECRET">,
    transport: typeof fetch = fetch,
    private until = Date.now() + 25000,
  ) {
    super(c, transport, until, "futures");
  }
  async loadFutures(previous?: FuturesLedger): Promise<FuturesData> {
    await this.syncTime();
    const warnings: string[] = [];
    const [accountResult, positionResult] = await Promise.allSettled([
      this.request("/fapi/v3/account", {}, true).then((raw) => {
        const result = accountSchema.parse(raw);
        const usdt = result.assets.find((a) => a.asset === "USDT");
        if (!usdt && !new Decimal(result.totalMarginBalance).isZero())
          throw new AppError("FUTURES_ASSET", "合约账户缺少 USDT 权益字段。", 502);
        return {
          equity: usdt?.marginBalance ?? "0",
          walletBalance: usdt?.walletBalance ?? "0",
          availableBalance: usdt?.availableBalance ?? "0",
          initialMargin: usdt?.initialMargin ?? "0",
        };
      }),
      this.request("/fapi/v3/positionRisk", {}, true).then((raw) =>
        positionsSchema.parse(raw).filter((p) => !new Decimal(p.positionAmt).isZero()),
      ),
    ]);
    const account = accountResult.status === "fulfilled" ? accountResult.value : undefined;
    const positions = positionResult.status === "fulfilled" ? positionResult.value : [];
    if (accountResult.status === "rejected")
      warnings.push(`合约账户权益读取失败：${reason(accountResult.reason)}`);
    if (positionResult.status === "rejected")
      warnings.push(`合约持仓读取失败：${reason(positionResult.reason)}`);
    const now = Date.now();
    const ledger: FuturesLedger = structuredClone(
      previous ?? {
        incomes: [],
        startTime: now - 89 * DAY,
        syncedThrough: 0,
        feeRates: {},
      },
    );
    const incomes = new Map(ledger.incomes.map((i) => [incomeKey(i), i]));
    const merge = (rows: FuturesIncome[]) => rows.forEach((i) => incomes.set(incomeKey(i), i));
    const page = async (startTime: number, endTime: number, p: number) =>
      incomeSchema.parse(
        await this.request(
          "/fapi/v1/income",
          {
            startTime: String(startTime),
            endTime: String(endTime),
            page: String(p),
            limit: "1000",
          },
          true,
        ),
      );
    let recentComplete = false;
    // Always read recent events first, even while older pages are still being backfilled.
    try {
      let n = 1;
      for (; n <= 3 && Date.now() < this.until - 1000; n++) {
        const rows = await page(now - 7 * DAY, now, n);
        merge(rows);
        if (rows.length < 1000) {
          recentComplete = true;
          break;
        }
      }
      if (!recentComplete) warnings.push("合约近期流水较多，正在继续同步。");
    } catch (e) {
      recentComplete = false;
      warnings.push(`合约最新资金流水读取失败：${reason(e)}`);
    }
    ledger.incomes = [...incomes.values()];
    // Fetch fills alongside backfill so slow historical income cannot hide recent trades.
    const tradesRequest = this.syncTrades(
      ledger,
      positions.map((p) => p.symbol),
      warnings,
    );
    if (previous && (ledger.syncedThrough || ledger.startTime) < now - 90 * DAY)
      ledger.historyGap = true;
    if (!ledger.pending)
      ledger.pending = {
        startTime: Math.max(ledger.startTime, ledger.syncedThrough - DAY),
        endTime: now,
        page: 1,
      };
    let historyComplete = false;
    try {
      for (let n = 0; n < 5 && Date.now() < this.until - 1000; n++) {
        const window = ledger.pending!;
        const rows = await page(window.startTime, window.endTime, window.page);
        merge(rows);
        if (rows.length < 1000) {
          ledger.syncedThrough = window.endTime;
          delete ledger.pending;
          historyComplete = true;
          break;
        }
        window.page++;
      }
    } catch (e) {
      warnings.push(`合约历史流水同步中断：${reason(e)}`);
    }
    ledger.incomes = [...incomes.values()].sort((a, b) => a.time - b.time);
    // Preserve fees in their original currency; convert third-token fees at event-time prices.
    const missingRates = new Map(
      ledger.incomes
        .filter(
          (i) =>
            i.asset !== "USDT" &&
            !new Decimal(i.income).isZero() &&
            ["COMMISSION", "REALIZED_PNL", "FUNDING_FEE"].includes(i.incomeType) &&
            !ledger.feeRates[incomeRateKey(i)],
        )
        .map((i) => [incomeRateKey(i), i]),
    );
    for (const [key, i] of [...missingRates].slice(0, 8)) {
      if (Date.now() >= this.until - 1000) break;
      try {
        const start = Math.floor(i.time / 60000) * 60000;
        const rows = z.array(z.array(z.unknown())).parse(
          await this.request("/fapi/v1/klines", {
            symbol: `${i.asset}USDT`,
            interval: "1m",
            startTime: String(start),
            endTime: String(start + 59999),
            limit: "1",
          }),
        );
        if (rows[0]?.[0] === start) {
          const rate = decimal.parse(rows[0][4]);
          if (new Decimal(rate).gt(0)) ledger.feeRates[key] = rate;
        }
      } catch {
        /* A missing conversion remains unknown, never silently zero. */
      }
    }
    if (!historyComplete) warnings.push("合约历史流水同步中，盈亏为已读取流水的暂计值。");
    if (ledger.historyGap)
      warnings.push("合约流水存在超出接口保留期的缺口，请管理员核对历史资金记录。");
    let tradesComplete = await tradesRequest;
    if (ledger.incomes.some((i) => i.symbol && !ledger.tradeSync?.[i.symbol]?.complete)) {
      tradesComplete = false;
      warnings.push("合约历史成交记录正在补齐。");
    }
    return {
      account,
      positionsComplete: positionResult.status === "fulfilled",
      trades: ledger.trades ?? [],
      tradesComplete,
      positions,
      ledger,
      complete: recentComplete && historyComplete && !ledger.historyGap,
      warnings,
    };
  }

  async futuresTrades(symbol: string, params: Record<string, string> = {}): Promise<Trade[]> {
    const rows = tradesSchema.parse(
      await this.request("/fapi/v1/userTrades", { symbol, limit: "1000", ...params }, true),
    );
    return rows.map((t) => ({
      instrument: "futures",
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      price: t.price,
      quantity: t.qty,
      quoteQuantity: t.quoteQty,
      fee: t.commission,
      feeAsset: t.commissionAsset,
      time: t.time,
      isMaker: t.maker,
      realizedPnl: t.realizedPnl,
      positionSide: t.positionSide,
    }));
  }
  private async syncTrades(ledger: FuturesLedger, openSymbols: string[], warnings: string[]) {
    const rows = new Map((ledger.trades ?? []).map((t) => [`${t.symbol}:${t.id}`, t]));
    ledger.tradeSync ??= {};
    const symbols = [
      ...new Set([
        ...openSymbols,
        ...ledger.incomes.map((i) => i.symbol).filter(Boolean),
        ...Object.keys(ledger.tradeSync),
      ]),
    ].sort((a, b) => (ledger.tradeSync?.[a]?.endTime ?? 0) - (ledger.tradeSync?.[b]?.endTime ?? 0));
    let complete = true;
    let budget = 8;
    for (const symbol of symbols) {
      if (budget <= 0 || Date.now() >= this.until - 1000) {
        complete = false;
        break;
      }
      try {
        // Fresh fills are never held behind older historical pages.
        const recent = await this.futuresTrades(symbol);
        budget--;
        recent.forEach((t) => rows.set(`${t.symbol}:${t.id}`, t));
        const hints = ledger.incomes.filter(
          (i) => i.symbol === symbol && i.tradeId && /^\d+$/.test(i.tradeId),
        );
        const earliestId = hints
          .map((i) => i.tradeId!)
          .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))[0];
        const sync = (ledger.tradeSync[symbol] ??= {
          nextId: earliestId ?? "0",
          startTime: ledger.startTime,
          endTime: Date.now(),
          complete: false,
        });
        if (Date.now() - sync.endTime > 7 * DAY) sync.complete = false;
        sync.endTime = Date.now();
        if (
          earliestId &&
          BigInt(earliestId) < BigInt(sync.nextId) &&
          !rows.has(`${symbol}:${earliestId}`)
        ) {
          sync.nextId = earliestId;
          sync.complete = false;
        }
        if (!sync.complete || recent.length === 1000) {
          // fromId and time filters are mutually exclusive; an ID cursor includes same-ms fills.
          if (budget <= 0 || Date.now() >= this.until - 1000) {
            complete = false;
            continue;
          }
          const older = await this.futuresTrades(symbol, { fromId: sync.nextId });
          budget--;
          older.forEach((t) => rows.set(`${t.symbol}:${t.id}`, t));
          if (older.length)
            sync.nextId = (
              older.reduce((a, t) => (BigInt(t.id) > a ? BigInt(t.id) : a), 0n) + 1n
            ).toString();
          sync.complete = older.length < 1000;
        }
        complete &&= sync.complete;
      } catch (e) {
        complete = false;
        warnings.push(`合约 ${symbol} 成交读取失败：${reason(e)}`);
      }
    }
    ledger.trades = [...rows.values()].sort((a, b) => b.time - a.time);
    if (!complete) warnings.push("合约成交记录正在补齐。");
    return complete;
  }
}
