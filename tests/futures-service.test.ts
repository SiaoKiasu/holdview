import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  spot: vi.fn(),
  futures: vi.fn(),
  ledger: vi.fn(),
  save: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("@/lib/binance", () => ({
  BinanceClient: class {
    load = mocks.spot;
  },
}));
vi.mock("@/lib/binance-futures", () => ({
  BinanceFuturesClient: class {
    loadFutures = mocks.futures;
  },
  incomeRateKey: (i: { asset: string; time: number }) =>
    `${i.asset}:${Math.floor(i.time / 60000) * 60000}`,
}));
vi.mock("@/lib/cost-store", () => ({ readCosts: async () => ({ costs: { BTC: "100" } }) }));
vi.mock("@/lib/ledger-store", () => ({ readLedger: mocks.ledger, saveLedger: mocks.save }));
vi.mock("@/lib/storage", () => ({ saveSnapshot: mocks.snapshot, readHistory: async () => [] }));
import { dashboard } from "@/lib/service";
import { getAccountConfig } from "@/lib/config";
import { configure, fixture } from "./helpers";
import { randomUUID } from "node:crypto";
function setup() {
  const c = {
    ...getAccountConfig(configure(fixture("binance")), "alice-account"),
    ACCOUNT_ID: randomUUID(),
    DATABASE_URL: "postgresql://test.invalid/test",
  };
  mocks.ledger.mockResolvedValue(undefined);
  mocks.spot.mockImplementation(async () => ({
    balances: [{ asset: "USDT", free: "850", locked: "0" }],
    tickers: [],
    spotEquity: "850",
    ledger: { version: 1, markets: {} },
    trades: [],
    orders: [],
    warnings: [],
    tradesComplete: true,
    ordersComplete: true,
  }));
  mocks.futures.mockResolvedValue({
    account: { equity: "166", walletBalance: "156", availableBalance: "56", initialMargin: "110" },
    positionsComplete: true,
    trades: [],
    tradesComplete: true,
    positions: [
      {
        symbol: "NEWUSDT",
        positionSide: "BOTH",
        positionAmt: "2",
        entryPrice: "50",
        markPrice: "55",
        unRealizedProfit: "10",
        marginAsset: "USDT",
      },
    ],
    ledger: {
      startTime: 1,
      syncedThrough: 2,
      feeRates: {},
      incomes: [
        {
          tranId: "1",
          symbol: "NEWUSDT",
          incomeType: "COMMISSION",
          income: "-1",
          asset: "USDT",
          time: 60000,
        },
        {
          tranId: "2",
          symbol: "NEWUSDT",
          incomeType: "FUNDING_FEE",
          income: "2",
          asset: "USDT",
          time: 60000,
        },
        {
          tranId: "3",
          symbol: "NEWUSDT",
          incomeType: "REALIZED_PNL",
          income: "5",
          asset: "USDT",
          time: 60000,
        },
      ],
    },
    complete: true,
    warnings: [],
  });
  return c;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("spot and futures dashboard", () => {
  it("adds only exchange wallet equities, including fees and funding already settled in the wallet", async () => {
    const c = setup();
    const d = await dashboard(c, true);
    expect(d.summary).toMatchObject({
      equity: "1016",
      equitySource: "exchange",
      equityComplete: true,
      futuresEquity: "166",
      cash: "850",
      realizedPnl: "4",
      unrealizedPnl: "12",
      feePnl: "-1",
    });
    expect(d.summary).not.toHaveProperty("futuresNetTransfer");
    expect(d.holdings[1]).toMatchObject({ asset: "NEW", averageCost: "50", unrealizedPnl: "12" });
    expect(d.holdings[1].allocation).toBeCloseTo((110 / 1016) * 100);
    expect(mocks.snapshot.mock.calls[0][1].equity).toBe("1016");
  });
  it("shows exchange floating PnL without manual cost even when income has not loaded", async () => {
    const c = setup();
    const future = await mocks.futures();
    future.complete = false;
    future.ledger.incomes = [];
    mocks.futures.mockResolvedValue(future);
    const d = await dashboard(c, true);
    expect(d.summary).toMatchObject({
      equity: "1016",
      equityComplete: true,
      unrealizedPnl: "10",
      holdingPnlComplete: false,
    });
    expect(d.holdings[1]).toMatchObject({
      unrealizedPnl: "10",
      averageCost: "50",
      pnlComplete: false,
      fundingPnl: null,
    });
    expect(mocks.snapshot).toHaveBeenCalledOnce();
  });
  it("never fabricates missing futures equity or records a spot-only snapshot as the total", async () => {
    const c = setup();
    mocks.futures.mockRejectedValueOnce(new Error("denied"));
    const d = await dashboard(c, true);
    expect(d.summary).toMatchObject({ equity: "850", equityComplete: false, futuresEquity: null });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it("keeps futures trade details separate from spot with identical IDs and sorts both by time", async () => {
    const c = setup();
    const spot = await mocks.spot();
    const future = await mocks.futures();
    const trade = {
      id: "42",
      symbol: "NEWUSDT",
      side: "BUY",
      price: "50",
      quantity: "1",
      quoteQuantity: "50",
      fee: "0.01",
      feeAsset: "USDT",
      time: 1,
      isMaker: true,
    };
    spot.trades = [trade];
    future.trades = [{ ...trade, instrument: "futures", time: 2 }];
    mocks.spot.mockResolvedValue(spot);
    mocks.futures.mockResolvedValue(future);
    const d = await dashboard(c);
    expect(d.trades).toHaveLength(2);
    expect(d.trades[0].instrument).toBe("futures");
    expect(d.trades[1].instrument).toBeUndefined();
    expect(d.summary.tradeCount).toBe(2);
  });
  it("does not add either wallet's floating profit to exchange equity again", async () => {
    const c = setup();
    const spot = await mocks.spot();
    spot.balances = [
      { asset: "USDT", free: "740", locked: "0" },
      { asset: "BTC", free: "1", locked: "0" },
    ];
    spot.tickers = [{ symbol: "BTCUSDT", lastPrice: "110", priceChangePercent: "0" }];
    mocks.spot.mockResolvedValue(spot);
    const d = await dashboard(c);
    expect(d.summary).toMatchObject({ equity: "1016", unrealizedPnl: "22" });
  });
  it("queries futures automatically without any legacy transfer settings", async () => {
    const c = setup();
    await dashboard(c);
    expect(mocks.futures).toHaveBeenCalledOnce();
  });
});
