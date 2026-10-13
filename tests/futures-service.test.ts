import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  spot: vi.fn(),
  futures: vi.fn(),
  settings: vi.fn(),
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
vi.mock("@/lib/futures-store", () => ({ readFuturesSettings: mocks.settings }));
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
  mocks.settings.mockResolvedValue({ netTransfer: "150" });
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
  it("adds exactly the manual 150, never futures notional or PnL, and snapshots the same total", async () => {
    const c = setup();
    const d = await dashboard(c, true);
    expect(d.summary).toMatchObject({
      equity: "1000",
      futuresNetTransfer: "150",
      cash: "850",
      realizedPnl: "4",
      unrealizedPnl: "12",
      feePnl: "-1",
      futuresFundingPnl: "2",
    });
    expect(d.holdings).toHaveLength(2);
    expect(d.holdings[1]).toMatchObject({ instrument: "futures", asset: "NEW", allocation: 11 });
    expect(mocks.snapshot.mock.calls[0][1].equity).toBe("1000");
    expect(mocks.save.mock.calls[0][1].futures.incomes).toHaveLength(3);
    mocks.settings.mockResolvedValue({ netTransfer: "100" });
    expect((await dashboard(c)).summary.equity).toBe("950");
  });
  it("keeps fixed transfer valuation on a futures outage but marks both PnL totals unknown", async () => {
    const c = setup();
    mocks.futures.mockRejectedValueOnce(new Error("no access"));
    const d = await dashboard(c);
    expect(d.summary).toMatchObject({
      equity: "1000",
      realizedPnl: null,
      unrealizedPnl: null,
      realizedPnlComplete: false,
    });
    expect(d.connection.futuresComplete).toBe(false);
    expect(d.warnings.join()).toContain("合约账户暂未读取成功");
  });
  it("does not call futures for unset transfers, but explicit zero keeps monitoring enabled", async () => {
    const c = setup();
    mocks.settings.mockResolvedValue({ netTransfer: null });
    expect((await dashboard(c)).summary.equity).toBe("850");
    expect(mocks.futures).not.toHaveBeenCalled();
    mocks.settings.mockResolvedValue({ netTransfer: "0" });
    const d = await dashboard(c);
    expect(d.summary).toMatchObject({ equity: "850", realizedPnl: "4" });
    expect(mocks.futures).toHaveBeenCalledOnce();
  });
  it("does not return a misleading total if configured transfer cannot be read", async () => {
    const c = setup();
    mocks.settings.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(dashboard(c)).rejects.toThrow("database unavailable");
    expect(mocks.spot).not.toHaveBeenCalled();
  });
});
