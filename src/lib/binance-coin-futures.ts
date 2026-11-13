import "server-only";
import Decimal from "decimal.js";
import { z } from "zod";
import { BinanceClient } from "./binance";
import {
  BinanceFuturesClient,
  decimal,
  transactionId,
  incomeSchema,
  incomeRateKey,
} from "./binance-futures";
import { incomeIdentity } from "./futures-units";
import type { Config } from "./config";
import type {
  CoinWallet,
  FuturesData,
  FuturesLedger,
  FuturesPosition,
  Order,
  Trade,
} from "./types";
const D = (v: Decimal.Value) => new Decimal(v);
const DAY = 86400000;
const metadataSchema = z.object({
  symbols: z.array(
    z.object({
      symbol: z.string(),
      baseAsset: z.string(),
      marginAsset: z.string(),
      quoteAsset: z.string(),
      contractSize: z.union([z.number(), decimal]).transform(String),
      contractType: z.string(),
    }),
  ),
});
type Contract = z.infer<typeof metadataSchema>["symbols"][number];
const accountSchema = z.object({
  assets: z.array(
    z.object({
      asset: z.string(),
      walletBalance: decimal,
      marginBalance: decimal,
      unrealizedProfit: decimal,
      availableBalance: decimal,
      initialMargin: decimal,
    }),
  ),
  positions: z.array(
    z.object({
      symbol: z.string(),
      positionSide: z.enum(["BOTH", "LONG", "SHORT"]),
      initialMargin: decimal,
      maintMargin: decimal.optional(),
      isolated: z.boolean().optional(),
      isolatedWallet: decimal.optional(),
    }),
  ),
});
const positionSchema = z.array(
  z.object({
    symbol: z.string(),
    positionSide: z.enum(["BOTH", "LONG", "SHORT"]),
    positionAmt: decimal,
    entryPrice: decimal,
    markPrice: decimal,
    unRealizedProfit: decimal,
    liquidationPrice: decimal.optional(),
    marginType: z.enum(["cross", "isolated"]).optional(),
  }),
);
const tradeSchema = z.array(
  z.object({
    id: transactionId,
    symbol: z.string(),
    side: z.enum(["BUY", "SELL"]),
    price: decimal,
    qty: decimal,
    commission: decimal,
    commissionAsset: z.string(),
    realizedPnl: decimal,
    time: z.number(),
    maker: z.boolean(),
    positionSide: z.enum(["BOTH", "LONG", "SHORT"]).optional(),
  }),
);

// CM uses inverse USD-face contracts. Do not treat its qty (contracts) or native
// PnL (settlement coin) as a linear USDT position. Retain native values explicitly.
export class BinanceCoinFuturesClient extends BinanceFuturesClient {
  private contracts = new Map<string, Contract>();
  private spot: BinanceClient;
  constructor(
    c: Pick<Config, "BINANCE_ENV" | "BINANCE_API_KEY" | "BINANCE_API_SECRET">,
    transport: typeof fetch = fetch,
    until = Date.now() + 25000,
  ) {
    super(c, transport, until, "coin");
    this.spot = new BinanceClient(c, transport, until);
  }
  private contract(symbol: string) {
    const m = this.contracts.get(symbol);
    if (!m || m.quoteAsset !== "USD" || m.baseAsset !== m.marginAsset || !D(m.contractSize).gt(0))
      throw Error("币本位合约规格缺失");
    return m;
  }
  async futuresTrades(symbol: string, params: Record<string, string> = {}): Promise<Trade[]> {
    const m = this.contract(symbol);
    return tradeSchema
      .parse(await this.request("/dapi/v1/userTrades", { symbol, limit: "1000", ...params }, true))
      .map((t) => ({
        instrument: "futures",
        contractMarket: "coin",
        baseAsset: m.baseAsset,
        contractSize: m.contractSize,
        realizedPnlAsset: m.marginAsset,
        id: t.id,
        symbol: t.symbol,
        side: t.side,
        price: t.price,
        quantity: t.qty,
        quoteQuantity: D(t.qty).mul(m.contractSize).toString(),
        fee: t.commission,
        feeAsset: t.commissionAsset,
        realizedPnl: t.realizedPnl,
        positionSide: t.positionSide,
        time: t.time,
        isMaker: t.maker,
      }));
  }
  async openOrders(algo: boolean): Promise<Order[]> {
    return (await super.openOrders(algo)).map((o) => {
      const m = this.contract(o.symbol);
      return {
        ...o,
        contractMarket: "coin",
        contractSize: m.contractSize,
        baseAsset: m.baseAsset,
        quoteAsset: "USD",
        executedQuote: D(o.executedQuantity).mul(m.contractSize).toString(),
      };
    });
  }
  async loadFutures(previous?: FuturesLedger): Promise<FuturesData> {
    await this.syncTime();
    const warnings: string[] = [];
    // Metadata and FX are public, and never receive API credentials.
    const [meta, prices, accountResult, riskResult] = await Promise.allSettled([
      this.request("/dapi/v1/exchangeInfo").then((v) => metadataSchema.parse(v)),
      this.spot
        .request("/api/v3/ticker/price")
        .then((v) => z.array(z.object({ symbol: z.string(), price: decimal })).parse(v)),
      this.request("/dapi/v1/account", {}, true).then((v) => accountSchema.parse(v)),
      this.request("/dapi/v1/positionRisk", {}, true).then((v) => positionSchema.parse(v)),
    ]);
    if (meta.status === "fulfilled")
      for (const m of meta.value.symbols) this.contracts.set(m.symbol, m);
    else warnings.push("币本位合约规格读取失败，张数换算待补齐。");
    const fx = new Map(
      prices.status === "fulfilled" ? prices.value.map((p) => [p.symbol, p.price]) : [],
    );
    const rate = (asset: string) => (asset === "USDT" ? "1" : fx.get(asset + "USDT"));
    let account: FuturesData["account"];
    let coinWallets: CoinWallet[] = [];
    if (accountResult.status === "fulfilled") {
      const assets = accountResult.value.assets.filter((a) =>
        [
          a.walletBalance,
          a.marginBalance,
          a.unrealizedProfit,
          a.initialMargin,
          a.availableBalance,
        ].some((v) => !D(v).isZero()),
      );
      if (assets.every((a) => Number(rate(a.asset)) > 0)) {
        coinWallets = assets.map((a) => ({ ...a, price: rate(a.asset)! }));
        const sum = (
          key: "marginBalance" | "walletBalance" | "availableBalance" | "initialMargin",
        ) => coinWallets.reduce((v, a) => v.plus(D(a[key]).mul(a.price)), D(0)).toString();
        account = {
          equity: sum("marginBalance"),
          walletBalance: sum("walletBalance"),
          availableBalance: sum("availableBalance"),
          initialMargin: sum("initialMargin"),
        };
      } else warnings.push("币本位钱包折算行情待补齐，权益暂不可用。");
    } else warnings.push("币本位账户读取失败，请检查当前 API 的合约读取权限与 IP 限制。");
    const positions: FuturesPosition[] = [];
    let positionsComplete = riskResult.status === "fulfilled" && !!account;
    if (riskResult.status === "fulfilled") {
      for (const p of riskResult.value.filter((p) => !D(p.positionAmt).isZero())) {
        try {
          const m = this.contract(p.symbol),
            conversion = rate(m.marginAsset);
          if (
            !conversion ||
            !D(conversion).gt(0) ||
            !D(p.markPrice).gt(0) ||
            !D(p.entryPrice).gt(0)
          )
            throw Error("价格缺失");
          const info =
            accountResult.status === "fulfilled"
              ? accountResult.value.positions.find(
                  (v) => v.symbol === p.symbol && v.positionSide === p.positionSide,
                )
              : undefined;
          const convert = (v?: string) =>
            v === undefined ? undefined : D(v).mul(conversion).toString();
          positions.push({
            ...p,
            contractMarket: "coin",
            contractType: m.contractType,
            baseAsset: m.baseAsset,
            marginAsset: m.marginAsset,
            contracts: p.positionAmt,
            contractSize: m.contractSize,
            positionAmt: D(p.positionAmt).mul(m.contractSize).div(p.markPrice).toString(),
            nativeUnrealizedPnl: p.unRealizedProfit,
            settlementPrice: conversion,
            unRealizedProfit: D(p.unRealizedProfit).mul(conversion).toString(),
            initialMargin: convert(info?.initialMargin),
            maintMargin: convert(info?.maintMargin),
            isolatedWallet: convert(info?.isolatedWallet),
            marginType:
              p.marginType ??
              (info?.isolated === undefined ? undefined : info.isolated ? "isolated" : "cross"),
          });
        } catch {
          positionsComplete = false;
          warnings.push(`币本位 ${p.symbol} 换算待补齐，暂不计算总敞口。`);
        }
      }
    } else warnings.push("币本位仓位读取失败，暂不计算总敞口。");
    const orderResults = await Promise.allSettled([this.openOrders(false), this.openOrders(true)]);
    const orders = orderResults.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const ordersComplete = orderResults.every((r) => r.status === "fulfilled");
    if (!ordersComplete) warnings.push("币本位挂单或条件单读取失败。");
    const now = Date.now();
    const ledger: FuturesLedger = structuredClone(
      previous ?? { incomes: [], startTime: now - 89 * DAY, syncedThrough: 0, feeRates: {} },
    );
    const incomes = new Map(ledger.incomes.map((i) => [incomeIdentity(i), i]));
    const readWindow = async (w: { startTime: number; endTime: number }) => {
      const rows = incomeSchema.parse(
        await this.request(
          "/dapi/v1/income",
          {
            startTime: String(w.startTime),
            endTime: String(w.endTime),
            limit: "1000",
          },
          true,
        ),
      );
      for (const row of rows) {
        const i = { ...row, contractMarket: "coin" as const };
        incomes.set(incomeIdentity(i), i);
      }
      return rows.length;
    };
    // DAPI income has NO page parameter. Split saturated time windows instead of
    // silently fetching page 1 forever. Never skip a saturated millisecond.
    const walk = async (queue: { startTime: number; endTime: number }[], budget: number) => {
      for (let i = 0; queue.length && i < budget && Date.now() < this.until - 1000; i++) {
        const w = queue[0];
        const count = await readWindow(w);
        if (count < 1000) queue.shift();
        else {
          if (w.startTime === w.endTime) throw Error("同毫秒流水超过接口上限");
          const mid = Math.floor((w.startTime + w.endTime) / 2);
          queue.splice(
            0,
            1,
            { startTime: w.startTime, endTime: mid },
            { startTime: mid + 1, endTime: w.endTime },
          );
        }
      }
      return queue.length === 0;
    };
    let recentComplete = false,
      historyComplete = false;
    try {
      recentComplete = await walk([{ startTime: now - 7 * DAY, endTime: now }], 3);
    } catch {
      warnings.push("币本位最新资金流水读取失败。");
    }
    if (ledger.syncedThrough && ledger.syncedThrough < now - 365 * DAY) ledger.historyGap = true;
    ledger.incomeWindows ??= [
      { startTime: Math.max(ledger.startTime, ledger.syncedThrough - DAY), endTime: now },
    ];
    const historyEnd = Math.max(...ledger.incomeWindows.map((w) => w.endTime));
    try {
      historyComplete = await walk(ledger.incomeWindows, 6);
      if (historyComplete) {
        ledger.syncedThrough = historyEnd;
        delete ledger.incomeWindows;
      }
    } catch {
      warnings.push("币本位历史流水同步中断，将继续补齐。");
    }
    ledger.incomes = [...incomes.values()].sort((a, b) => a.time - b.time);
    const tradesComplete = await this.syncTrades(
      ledger,
      [...positions.map((p) => p.symbol), ...orders.map((o) => o.symbol)],
      warnings,
    );
    // Historical native-coin amounts use the minute of each event, never today's price.
    const missing = new Map(
      ledger.incomes
        .filter(
          (i) =>
            i.asset !== "USDT" &&
            !D(i.income).isZero() &&
            ["COMMISSION", "REALIZED_PNL", "FUNDING_FEE"].includes(i.incomeType) &&
            !ledger.feeRates[incomeRateKey(i)],
        )
        .map((i) => [incomeRateKey(i), { asset: i.asset, time: i.time }]),
    );
    for (const t of ledger.trades ?? []) {
      for (const asset of [t.feeAsset, t.realizedPnlAsset!]) {
        const key = `${asset}:${Math.floor(t.time / 60000) * 60000}`;
        if (asset !== "USDT" && !ledger.feeRates[key]) missing.set(key, { asset, time: t.time });
      }
    }
    for (const [key, i] of [...missing].slice(0, 16)) {
      if (Date.now() >= this.until - 1000) break;
      try {
        const start = Math.floor(i.time / 60000) * 60000;
        const rows = z.array(z.array(z.unknown())).parse(
          await this.spot.request("/api/v3/klines", {
            symbol: i.asset + "USDT",
            interval: "1m",
            startTime: String(start),
            endTime: String(start + 59999),
            limit: "1",
          }),
        );
        if (rows[0]?.[0] === start) {
          const value = decimal.parse(rows[0][4]);
          if (D(value).gt(0)) ledger.feeRates[key] = value;
        }
      } catch {
        /* Missing rates remain unknown and are retried next account sync. */
      }
    }
    if (!recentComplete || !historyComplete || ledger.historyGap)
      warnings.push("币本位历史流水同步中，盈亏为已读取流水的暂计值。");
    return {
      account,
      coinWallets,
      positions,
      positionsComplete,
      orders,
      ordersComplete,
      trades: ledger.trades ?? [],
      tradesComplete,
      ledger,
      complete: recentComplete && historyComplete && !ledger.historyGap,
      warnings,
    };
  }
}
