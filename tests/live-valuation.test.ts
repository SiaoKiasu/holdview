import { describe, expect, it } from "vitest";
import type { Dashboard, Holding } from "@/lib/types";
import { liveValuation, type MarketQuotes } from "@/lib/live-valuation";
const holding = (
  asset: string,
  quantity: string,
  price: string,
  cost: string,
  pnl: string | null,
): Holding => ({
  asset,
  quantity,
  price,
  averageCost: cost,
  unrealizedPnl: pnl,
  value: String(Number(quantity) * Number(price)),
  free: quantity,
  locked: "0",
  allocation: 0,
  change24h: 0,
});
function fixture(): Dashboard {
  return {
    source: "binance",
    accountLabel: "test",
    environment: "Binance Spot",
    updatedAt: 100000,
    holdings: [
      holding("BTC", "2", "100", "90", "20"),
      holding("USDC", "10", "1", "1", null),
      holding("USDT", "500", "1", "1", null),
      {
        ...holding("BTC", "1", "100", "110", "12"),
        instrument: "futures",
        symbol: "BTCUSDT",
        fundingPnl: "2",
        returnRate: "10",
      },
    ],
    positionDetails: [
      {
        symbol: "BTCUSDT",
        positionSide: "SHORT",
        positionAmt: "-1",
        entryPrice: "110",
        markPrice: "100",
        unRealizedProfit: "10",
        marginAsset: "USDT",
      },
    ],
    hedgePeriods: {
      BTC: {
        startedAt: 10000,
        spotPnl: "-5",
        futuresPnl: "2",
        fundingPnl: "2",
        feePnl: "-1",
        netPnl: "-2",
        complete: true,
        note: "",
      },
    },
    summary: {
      equity: "810",
      equitySource: "exchange",
      equityComplete: true,
      pricedAssets: 4,
      unpricedAssets: 0,
      unrealizedPnl: "32",
      realizedPnl: "-3",
      feePnl: "-3",
      realizedPnlComplete: true,
      realizedPnlNote: "",
      costCoverage: 1,
      totalPnl: "10",
      principal: "800",
      cash: "500",
      cashFree: "500",
      cashLocked: "0",
      baseline: "800",
      baselineAt: null,
      netFlows: "0",
      stablecoinValue: "510",
      tradeCount: 0,
      futuresEquity: "100",
      futuresAvailable: "50",
    },
    history: [{ time: 100000, equity: "810" }],
    trades: [],
    orders: [],
    warnings: [],
    closedReview: { rows: [], complete: true },
    connection: {
      futuresEnabled: true,
      futuresPositionsComplete: true,
      database: true,
      snapshotsSaved: true,
      symbols: [],
      historySync: { scanned: 0, total: 0, oldestCheck: null },
      tradesComplete: true,
      ordersComplete: true,
    },
  };
}
const quotes = (): MarketQuotes => ({
  environment: "mainnet",
  spot: { time: 105000, prices: { BTCUSDT: "120", USDCUSDT: "1.01" } },
  futures: { time: 105000, prices: { BTCUSDT: "125" } },
});
describe("live market repricing", () => {
  it("marks spot and shorts independently without adding notional or charging fees/funding twice", () => {
    const base = fixture(),
      before = structuredClone(base),
      result = liveValuation(base, quotes(), 106000);
    expect(result.summary.equity).toBe("825.1"); // +40 spot, +0.1 USDC, -25 short
    expect(result.summary.unrealizedPnl).toBe("47"); // stablecoin drift is not holding PnL
    expect(result.summary.futuresEquity).toBe("75");
    expect(result.positionDetails![0].unRealizedProfit).toBe("-15");
    expect(result.holdings[3].unrealizedPnl).toBe("-13"); // funding +2 once
    expect(result.hedgePeriods!.BTC).toMatchObject({
      spotPnl: "35",
      futuresPnl: "-23",
      fundingPnl: "2",
      feePnl: "-1",
      netPnl: "13",
    });
    expect(result.summary).toMatchObject({
      realizedPnl: "-3",
      cash: "500",
      cashFree: "500",
      futuresAvailable: "50",
      equitySource: "calculated",
    });
    expect(result.history).toBe(base.history);
    expect(base).toEqual(before);
    expect(liveValuation(base, quotes(), 106000)).toEqual(result);
  });
  it("rejects old, future, cross-environment and demo quotes", () => {
    const b = fixture(),
      q = quotes();
    expect(liveValuation(b, q, 200000)).toBe(b);
    expect(liveValuation(b, q, 90000)).toBe(b);
    expect(liveValuation(b, { ...q, environment: "testnet" }, 106000)).toBe(b);
    expect(liveValuation({ ...b, updatedAt: 110000 }, q, 111000).marketUpdatedAt).toBeUndefined();
    expect(liveValuation({ ...b, source: "demo" }, q, 106000).summary.equity).toBe("810");
  });
  it("keeps missing quotes and null PnL unknown rather than zero", () => {
    const b = fixture();
    b.holdings[0].unrealizedPnl = null;
    b.summary.unrealizedPnl = null;
    const r = liveValuation(b, { ...quotes(), futures: null }, 106000);
    expect(r.holdings[0].unrealizedPnl).toBeNull();
    expect(r.summary.unrealizedPnl).toBeNull();
    expect(r.positionDetails![0].markPrice).toBe("100");
    expect(r.marketComplete).toBe(false);
    expect(r.summary.equity).toBe("850.1");
  });
  it("does not add futures deltas to spot-only equity when the wallet was unavailable", () => {
    const b = fixture();
    b.summary.equity = "710";
    b.summary.futuresEquity = null;
    b.summary.equityComplete = false;
    const r = liveValuation(b, quotes(), 106000);
    expect(r.summary.equity).toBe("750.1");
    expect(r.summary.futuresEquity).toBeNull();
    expect(r.summary.equityComplete).toBe(false);
  });
  it("supports bridge prices and does not mutate opposite hedge-mode legs", () => {
    const b = fixture();
    b.holdings[0] = { ...holding("ALT", "2", "100", "90", "20") };
    b.positionDetails!.push({
      ...b.positionDetails![0],
      positionSide: "LONG",
      positionAmt: "0.5",
      entryPrice: "90",
      unRealizedProfit: "5",
    });
    const q = quotes();
    q.spot!.prices = { ALTBTC: "1.2", BTCUSDT: "100", USDCUSDT: "1" };
    const r = liveValuation(b, q, 106000);
    expect(r.holdings[0].price).toBe("120");
    expect(r.positionDetails!.map((p) => p.unRealizedProfit)).toEqual(["-15", "17.5"]);
    expect(r.summary.futuresEquity).toBe("87.5");
  });
  it("rejects malformed/zero prices and preserves unknown starting valuations", () => {
    const b = fixture();
    b.holdings[0].price = null;
    b.holdings[0].value = null;
    const q = quotes();
    q.futures!.prices.BTCUSDT = "0";
    const r = liveValuation(b, q, 106000);
    expect(r.holdings[0].price).toBeNull();
    expect(r.positionDetails![0].markPrice).toBe("100");
    expect(r.marketComplete).toBe(false);
  });
});
