import { describe, it, expect } from "vitest";
import { closedReview } from "@/lib/closed-review";
import { formatPrice } from "@/lib/price-format";
import type { ProviderData, Trade, Holding } from "@/lib/types";
const t = (
  id: number,
  side: "BUY" | "SELL",
  q: string,
  price: string,
  extra: Partial<Trade> = {},
): Trade => ({
  id: String(id),
  symbol: "BTCUSDT",
  side,
  quantity: q,
  price,
  quoteQuantity: String(Number(q) * Number(price)),
  fee: "0",
  feeAsset: "USDT",
  time: id * 86400000,
  isMaker: false,
  ...extra,
});
function data(trades: Trade[]): ProviderData {
  return {
    balances: [],
    tickers: [],
    trades,
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
          nextId: "99",
          complete: true,
          checkedAt: 1,
          trades,
        },
      },
    },
  };
}
const holding = (value: string | null, instrument?: "futures"): Holding => ({
  asset: "BTC",
  free: "1",
  locked: "0",
  quantity: "1",
  price: value,
  value,
  allocation: 0,
  change24h: null,
  averageCost: "100",
  unrealizedPnl: "0",
  instrument,
});
describe("closed position review", () => {
  it("matches a partial close to weighted entry cost and allocates entry fees once", () => {
    const d = data([
      t(1, "BUY", "2", "100", { fee: "2" }),
      t(2, "BUY", "2", "200", { fee: "4" }),
      t(3, "SELL", "1", "180", { fee: "1" }),
      t(4, "SELL", "1", "210", { fee: "1" }),
    ]);
    const r = closedReview(d, [holding("300")]).rows[0];
    expect(r).toMatchObject({
      status: "partial",
      quantity: "2",
      averageEntry: "150",
      averageExit: "195",
      cost: "300",
      grossPnl: "90",
      fees: "5",
      netPnl: "85",
      closeCount: 2,
      complete: true,
    });
    expect(Number(r.returnRate)).toBeCloseTo((85 / 300) * 100);
    expect(r.holdingMs).toBe(2 * 86400000);
    expect(r.fills.map((f) => f.fees)).toEqual(["2.5", "2.5"]);
  });
  it("treats dust below one USDT as cleared, but exactly one as partial and unknown price as unknown", () => {
    const d = data([t(1, "BUY", "1", "100"), t(2, "SELL", "0.999", "110")]);
    expect(closedReview(d, [holding("0.9999")]).rows[0].status).toBe("closed");
    expect(closedReview(d, [holding("1")]).rows[0].status).toBe("partial");
    expect(closedReview(d, [holding(null)]).rows[0].status).toBe("unknown");
    expect(closedReview(d, []).rows[0].status).toBe("closed");
  });
  it("handles base-token buy and sell fees without double deducting commission", () => {
    const d = data([
      t(1, "BUY", "10", "100", { fee: "0.1", feeAsset: "BTC" }),
      t(2, "SELL", "9.8", "120", { fee: "0.1", feeAsset: "BTC" }),
    ]);
    const r = closedReview(d, []).rows[0];
    expect(r.cost).toBe("990");
    expect(r.fees).toBe("22");
    expect(r.grossPnl).toBe("198");
    expect(r.netPnl).toBe("176"); // 1,176 proceeds minus 1,000 initial cash
  });
  it("does not invent costs when opening history or fee conversion is missing", () => {
    expect(closedReview(data([t(1, "SELL", "1", "110")]), []).rows[0].netPnl).toBeNull();
    const d = data([
      t(1, "BUY", "1", "100", { fee: "0.1", feeAsset: "BNB" }),
      t(2, "SELL", "1", "120"),
    ]);
    expect(closedReview(d, []).rows[0].fees).toBeNull();
    expect(closedReview(d, []).rows[0].grossPnl).toBe("20");
    expect(closedReview(d, []).complete).toBe(false);
  });
  it("does not include buy-only positions and deduplicates fills beyond the display limit", () => {
    expect(closedReview(data([t(1, "BUY", "1", "100")]), [holding("100")]).rows).toHaveLength(0);
    const trades = Array.from({ length: 1002 }, (_, i) =>
      t(i + 1, i % 2 === 0 ? "BUY" : "SELL", "1", i % 2 === 0 ? "100" : "110"),
    );
    const d = data([...trades, trades[1]]);
    d.trades = trades.slice(-1000);
    const r = closedReview(d, []).rows[0];
    expect(r.closeCount).toBe(501);
    expect(r.netPnl).toBe("5010");
    expect(r.fills).toHaveLength(100);
  });
  it("uses exchange futures closing PnL including break-even fills, excludes funding and does not count shorts opening as exits", () => {
    const d = data([]);
    d.futures = {
      positions: [],
      positionsComplete: true,
      complete: true,
      tradesComplete: true,
      ledger: {
        incomes: [
          {
            tranId: "1",
            incomeType: "FUNDING_FEE",
            asset: "USDT",
            income: "5",
            symbol: "BTCUSDT",
            time: 1,
          },
        ],
        feeRates: {},
        startTime: 1,
        syncedThrough: 1,
      },
      trades: [
        t(1, "SELL", "2", "100", { instrument: "futures", realizedPnl: "0", fee: "2" }),
        t(2, "BUY", "1", "90", { instrument: "futures", realizedPnl: "10", fee: "1" }),
        t(3, "BUY", "1", "100", { instrument: "futures", realizedPnl: "0", fee: "1" }),
      ],
      warnings: [],
    };
    const r = closedReview(d, []).rows[0];
    expect(r).toMatchObject({
      status: "closed",
      closeCount: 2,
      grossPnl: "10",
      fees: "4",
      netPnl: "6",
      averageEntry: "100",
      averageExit: "95",
    });
  });
  it("keeps spot and futures inventories separate and allocates a reversing fill fee between closing and opening", () => {
    const d = data([t(1, "BUY", "1", "100"), t(2, "SELL", "1", "120")]);
    d.futures = {
      positions: [],
      complete: true,
      tradesComplete: true,
      warnings: [],
      ledger: { incomes: [], feeRates: {}, startTime: 1, syncedThrough: 1 },
      trades: [
        t(1, "BUY", "1", "100", { fee: "1", realizedPnl: "0" }),
        t(2, "SELL", "2", "120", { fee: "2", realizedPnl: "20" }),
        t(3, "BUY", "1", "110", { fee: "1", realizedPnl: "10" }),
      ],
    };
    const rows = closedReview(d, []).rows;
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.market === "spot")?.netPnl).toBe("20");
    expect(rows.find((r) => r.direction === "long")?.netPnl).toBe("18");
    expect(rows.find((r) => r.direction === "short")?.netPnl).toBe("8");
  });
  it("keeps hedge sides separate even with simultaneous long and short positions", () => {
    const d = data([]);
    d.futures = {
      positions: [],
      complete: true,
      tradesComplete: true,
      warnings: [],
      ledger: { incomes: [], feeRates: {}, startTime: 1, syncedThrough: 1 },
      trades: [
        t(1, "BUY", "1", "100", { positionSide: "LONG", realizedPnl: "0" }),
        t(2, "SELL", "1", "120", { positionSide: "SHORT", realizedPnl: "0" }),
        t(3, "SELL", "1", "110", { positionSide: "LONG", realizedPnl: "10" }),
        t(4, "BUY", "1", "110", { positionSide: "SHORT", realizedPnl: "10" }),
      ],
    };
    const rows = closedReview(d, []).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.direction === "long")).toMatchObject({
      closeCount: 1,
      averageEntry: "100",
      averageExit: "110",
      netPnl: "10",
    });
    expect(rows.find((r) => r.direction === "short")).toMatchObject({
      closeCount: 1,
      averageEntry: "120",
      averageExit: "110",
      netPnl: "10",
    });
  });
});
describe("price display", () => {
  it("uses two places at one and above, four below one, and does not round nonzero micro-prices to zero", () => {
    expect(formatPrice("81520.319")).toBe("81,520.32");
    expect(formatPrice("1")).toBe("1.00");
    expect(formatPrice("0.7")).toBe("0.7000");
    expect(formatPrice("0.08")).toBe("0.0800");
    expect(formatPrice("0.28752067")).toBe("0.2875");
    expect(formatPrice("0.000001")).toBe("0.0₅1");
    expect(formatPrice(null)).toBe("—");
  });
});

describe("inverse review instrument boundaries", () => {
  const coin = (
    id: number,
    side: "BUY" | "SELL",
    quantity: string,
    price: string,
    extra: Partial<Trade> = {},
  ) =>
    t(id, side, quantity, price, {
      instrument: "futures",
      contractMarket: "coin",
      symbol: "BTCUSD_PERP",
      baseAsset: "BTC",
      contractSize: "100",
      realizedPnlAsset: "BTC",
      realizedPnl: "0",
      ...extra,
    });
  function futuresData(trades: Trade[]) {
    const d = data([]);
    d.futures = {
      positions: [],
      positionsComplete: true,
      complete: true,
      tradesComplete: true,
      warnings: [],
      trades,
      ledger: { incomes: [], feeRates: {}, startTime: 1, syncedThrough: 1 },
    };
    return d;
  }
  it("never averages U-margined history into a COIN-M contract or its settlement inventory", () => {
    const d = futuresData([
      t(1, "SELL", "0.019", "78000", { realizedPnl: "0" }),
      t(2, "BUY", "0.019", "77000", { realizedPnl: "19" }),
      coin(3, "SELL", "70", "70000"),
      coin(4, "BUY", "70", "68000", { realizedPnl: "0.00294117647" }),
    ]);
    d.futures!.ledger.feeRates["BTC:" + 4 * 86400000] = "68000";
    const rows = closedReview(d, [holding("4000")]).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.contractMarket === "usd")).toMatchObject({
      symbol: "BTCUSDT",
      averageEntry: "78000",
      averageExit: "77000",
      quantity: "0.019",
      quantityUnit: "BTC",
      direction: "short",
    });
    expect(rows.find((r) => r.contractMarket === "coin")).toMatchObject({
      symbol: "BTCUSD_PERP",
      averageEntry: "70000",
      quantity: "70",
      quantityUnit: "张",
      direction: "short",
      status: "closed",
      remainingValue: "0",
    });
    expect(Number(rows.find((r) => r.contractMarket === "coin")!.averageExit)).toBeCloseTo(
      68000,
      8,
    );
  });
  it("uses contract-weighted inverse prices for multiple entries and exits", () => {
    const d = futuresData([
      coin(1, "SELL", "50", "50000"),
      coin(2, "SELL", "50", "100000"),
      coin(3, "BUY", "50", "40000"),
      coin(4, "BUY", "50", "80000"),
    ]);
    const r = closedReview(d, []).rows[0];
    expect(r.quantity).toBe("100");
    expect(Number(r.averageEntry)).toBeCloseTo(10000 / (5000 / 50000 + 5000 / 100000), 8);
    expect(Number(r.averageExit)).toBeCloseTo(10000 / (5000 / 40000 + 5000 / 80000), 8);
    expect(r.fills.map((f) => f.exitPrice)).toEqual(["80000", "40000"]);
    expect(r.fills.map((f) => f.quantity)).toEqual(["50", "50"]);
  });
  it("does not mark a closed short as open because another product or long remains", () => {
    const d = futuresData([coin(1, "SELL", "10", "50000"), coin(2, "BUY", "10", "40000")]);
    d.futures!.positions = [
      {
        symbol: "BTCUSDT",
        positionSide: "SHORT",
        positionAmt: "-1",
        entryPrice: "50000",
        markPrice: "40000",
        marginAsset: "USDT",
        unRealizedProfit: "10000",
      },
      {
        symbol: "BTCUSD_PERP",
        contractMarket: "coin",
        contracts: "5",
        contractSize: "100",
        baseAsset: "BTC",
        settlementPrice: "40000",
        positionSide: "LONG",
        positionAmt: "0.0125",
        entryPrice: "50000",
        markPrice: "40000",
        marginAsset: "BTC",
        unRealizedProfit: "-100",
      },
    ];
    expect(closedReview(d, []).rows[0]).toMatchObject({ status: "closed", remainingValue: "0" });
    d.futures!.positions[1].positionAmt = "-0.0125";
    d.futures!.positions[1].positionSide = "SHORT";
    expect(closedReview(d, []).rows[0]).toMatchObject({ status: "partial", remainingValue: "500" });
  });
});
