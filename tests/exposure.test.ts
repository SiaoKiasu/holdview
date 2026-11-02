import { describe, expect, it } from "vitest";
import { buildExposure } from "@/lib/exposure";
import { trackHedges } from "@/lib/hedge-tracking";
import type { Dashboard, ProviderData, FuturesPosition, Holding } from "@/lib/types";

const position = (amount: string, extra: Partial<FuturesPosition> = {}): FuturesPosition => ({
  symbol: "BTCUSDT",
  positionSide: amount.startsWith("-") ? "SHORT" : "LONG",
  positionAmt: amount,
  entryPrice: "100",
  markPrice: "110",
  unRealizedProfit: amount.startsWith("-") ? "-10" : "10",
  marginAsset: "USDT",
  ...extra,
});
const holding = (extra: Partial<Holding> = {}): Holding => ({
  asset: "BTC",
  quantity: "2",
  free: "2",
  locked: "0",
  price: "110",
  value: "220",
  allocation: 22,
  change24h: null,
  averageCost: "90",
  unrealizedPnl: "40",
  ...extra,
});
const dashboard = (): Pick<
  Dashboard,
  "holdings" | "positionDetails" | "summary" | "connection"
> => ({
  holdings: [
    holding(),
    holding({ asset: "USDT", quantity: "780", value: "780", price: "1", unrealizedPnl: null }),
    holding({
      instrument: "futures",
      symbol: "BTCUSDT",
      fundingPnl: "3",
      pnlComplete: true,
      unrealizedPnl: "-7",
    }),
  ],
  positionDetails: [position("-1")],
  summary: { equity: "1000", equityComplete: true } as Dashboard["summary"],
  connection: { futuresEnabled: true, futuresPositionsComplete: true } as Dashboard["connection"],
});
describe("portfolio exposure", () => {
  it("nets quantities while keeping both legs and excluding stablecoin cash", () => {
    const e = buildExposure(dashboard());
    expect(e).toMatchObject({ long: "220", short: "110", net: "110", netRatio: "11" });
    expect(e.groups.find((g) => g.asset === "BTC")).toMatchObject({
      spotQuantity: "2",
      shortQuantity: "1",
      netQuantity: "1",
      hedgeRatio: "50",
      hedgedValue: "110",
      holdingPnl: "33",
      status: "部分对冲",
    });
  });
  it("keeps hedge-mode longs and shorts separate, credits symbol funding once", () => {
    const d = dashboard();
    d.positionDetails = [position("1"), position("-3")];
    const g = buildExposure(d).groups.find((g) => g.asset === "BTC")!;
    expect(g.positions).toHaveLength(2);
    expect(g).toMatchObject({
      longQuantity: "1",
      shortQuantity: "3",
      netQuantity: "0",
      hedgeRatio: "100",
      status: "数量中性",
      holdingPnl: "43",
    });
  });
  it("reports overhedging above 100% and negative net exposure", () => {
    const d = dashboard();
    d.positionDetails = [position("-3")];
    expect(buildExposure(d)).toMatchObject({ net: "-110" });
    expect(buildExposure(d).groups.find((g) => g.asset === "BTC")).toMatchObject({
      hedgeRatio: "150",
      status: "超额对冲",
    });
  });
  it("does not net ETH shorts against BTC spot or infer multiplier contracts", () => {
    const d = dashboard();
    d.positionDetails = [
      position("-1", { symbol: "ETHUSDT" }),
      position("-1", { symbol: "1000PEPEUSDT" }),
    ];
    const e = buildExposure(d);
    expect(e.groups.filter((g) => g.hedged)).toHaveLength(0);
    expect(e.groups.find((g) => g.asset === "ETH")?.status).toBe("净空持仓");
  });
  it("does not fabricate zero shorts on API failure or supported valuation for other collateral", () => {
    const d = dashboard();
    d.connection.futuresPositionsComplete = false;
    d.positionDetails = [];
    expect(buildExposure(d)).toMatchObject({ complete: false, net: null, short: null });
    expect(buildExposure(d).groups[0].netQuantity).toBeNull();
    d.connection.futuresPositionsComplete = true;
    d.positionDetails = [position("-1", { marginAsset: "BTC", symbol: "BTCUSD_PERP" })];
    expect(buildExposure(d)).toMatchObject({ complete: false, net: null });
  });
  it("does not treat missing prices as zero or hide fully hedged gross positions", () => {
    const d = dashboard();
    d.positionDetails = [position("-2")];
    expect(buildExposure(d).groups.find((g) => g.asset === "BTC")).toMatchObject({
      netQuantity: "0",
      grossExposure: "440",
    });
    d.holdings[0].price = null;
    d.positionDetails = [position("-2", { markPrice: "0" })];
    expect(buildExposure(d).net).toBeNull();
  });
});

function provider(): ProviderData {
  return {
    balances: [{ asset: "BTC", free: "2", locked: "0" }],
    tickers: [{ symbol: "BTCUSDT", lastPrice: "100", priceChangePercent: "0" }],
    trades: [],
    orders: [],
    warnings: [],
    tradesComplete: true,
    ordersComplete: true,
    ledger: {
      version: 1,
      markets: {
        BTCUSDT: {
          baseAsset: "BTC",
          quoteAsset: "USDT",
          nextId: "0",
          complete: true,
          checkedAt: 0,
          trades: [],
        },
      },
    },
    futures: {
      positions: [position("-1", { markPrice: "100", unRealizedProfit: "0" })],
      positionsComplete: true,
      complete: true,
      warnings: [],
      ledger: { incomes: [], startTime: 0, syncedThrough: 2000, feeRates: {} },
    },
  };
}
describe("hedge observation accounting", () => {
  it("starts at the first complete observation and excludes prior spot losses and old fees", () => {
    const d = provider();
    d.futures!.ledger.incomes = [
      {
        symbol: "BTCUSDT",
        tranId: "old",
        incomeType: "COMMISSION",
        income: "-5",
        asset: "USDT",
        time: 900,
      },
    ];
    const first = trackHedges(d, 1000);
    expect(first.BTC).toMatchObject({ startedAt: 1000, netPnl: "0", feePnl: "0" });
    d.tickers[0].lastPrice = "90";
    d.futures!.positions[0].unRealizedProfit = "10";
    d.futures!.ledger.incomes.push({
      symbol: "BTCUSDT",
      tranId: "fund",
      incomeType: "FUNDING_FEE",
      income: "1.2",
      asset: "USDT",
      time: 1500,
    });
    expect(trackHedges(d, 2000).BTC).toMatchObject({
      spotPnl: "-20",
      futuresPnl: "10",
      fundingPnl: "1.2",
      netPnl: "-8.8",
    });
  });
  it("handles spot adds, base-asset fees, and partial futures closes without double counting", () => {
    const d = provider();
    trackHedges(d, 1000);
    d.ledger!.markets.BTCUSDT.trades.push({
      id: "1",
      symbol: "BTCUSDT",
      side: "BUY",
      price: "90",
      quantity: "1",
      quoteQuantity: "90",
      fee: "0.01",
      feeAsset: "BTC",
      time: 1500,
      isMaker: false,
    });
    d.balances[0].free = "2.99";
    d.tickers[0].lastPrice = "90";
    d.futures!.positions[0].positionAmt = "-0.5";
    d.futures!.positions[0].unRealizedProfit = "5";
    d.futures!.ledger.incomes.push(
      {
        symbol: "BTCUSDT",
        tranId: "close",
        incomeType: "REALIZED_PNL",
        income: "5",
        asset: "USDT",
        time: 1500,
      },
      {
        symbol: "BTCUSDT",
        tranId: "fee",
        incomeType: "COMMISSION",
        income: "-0.1",
        asset: "USDT",
        time: 1500,
      },
    );
    expect(trackHedges(d, 2000).BTC).toMatchObject({
      spotPnl: "-20",
      futuresPnl: "10",
      feePnl: "-1",
      netPnl: "-11",
      complete: true,
    });
  });
  it("flags transfers rather than treating deposits as profit", () => {
    const d = provider();
    trackHedges(d, 1000);
    d.balances[0].free = "3";
    expect(trackHedges(d, 2000).BTC).toMatchObject({ complete: false, netPnl: null });
  });
  it("retains anchors on outages, does not start with incomplete history, clears on observed hedge closure", () => {
    const d = provider();
    d.futures!.complete = false;
    expect(trackHedges(d, 1000)).toEqual({});
    d.futures!.complete = true;
    trackHedges(d, 2000);
    d.futures!.positionsComplete = false;
    d.futures!.positions = [];
    expect(trackHedges(d, 3000)).toEqual({});
    expect(d.ledger!.hedgeAnchors!.BTC.startedAt).toBe(2000);
    d.futures!.positionsComplete = true;
    trackHedges(d, 4000);
    expect(d.ledger!.hedgeAnchors!.BTC).toBeUndefined();
  });
  it("waits for rates and deduplicates income events", () => {
    const d = provider();
    trackHedges(d, 1000);
    const fee = {
      symbol: "BTCUSDT",
      tranId: "x",
      incomeType: "COMMISSION",
      income: "-0.01",
      asset: "BNB",
      time: 1500,
    };
    d.futures!.ledger.incomes.push(fee, fee);
    expect(trackHedges(d, 2000).BTC.netPnl).toBeNull();
    d.futures!.ledger.feeRates["BNB:0"] = "300";
    expect(trackHedges(d, 2000).BTC).toMatchObject({ netPnl: "-3", feePnl: "-3" });
  });
});

it("tracks hedge-mode long and short positions without spot inventory", () => {
  const d = provider();
  d.balances = [];
  d.futures!.positions = [
    position("1", { unRealizedProfit: "0" }),
    position("-1", { unRealizedProfit: "0" }),
  ];
  expect(trackHedges(d, 1000).BTC).toMatchObject({ spotPnl: "0", netPnl: "0", complete: true });
  d.futures!.positions[0].unRealizedProfit = "10";
  d.futures!.positions[1].unRealizedProfit = "-10";
  expect(trackHedges(d, 2000).BTC).toMatchObject({ startedAt: 1000, netPnl: "0" });
});
