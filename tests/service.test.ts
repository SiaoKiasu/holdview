vi.mock("@/lib/binance-futures", () => ({
  BinanceFuturesClient: class {
    async loadFutures() {
      return {
        account: { equity: "0", walletBalance: "0", availableBalance: "0", initialMargin: "0" },
        positions: [],
        positionsComplete: true,
        trades: [],
        tradesComplete: true,
        ledger: { incomes: [], feeRates: {}, startTime: 0, syncedThrough: Date.now() },
        complete: true,
        warnings: [],
      };
    }
  },
  incomeRateKey: (i: { asset: string; time: number }) =>
    `${i.asset}:${Math.floor(i.time / 60000) * 60000}`,
}));
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  history: vi.fn(),
  costs: vi.fn(),
}));
vi.mock("@/lib/binance", () => ({
  BinanceClient: class {
    load = mocks.load;
  },
}));
vi.mock("@/lib/cost-store", () => ({ readCosts: mocks.costs }));
vi.mock("@/lib/ledger-store", () => ({ readLedger: vi.fn(), saveLedger: vi.fn() }));
vi.mock("@/lib/storage", () => ({ saveSnapshot: mocks.save, readHistory: mocks.history }));
import { dashboard } from "@/lib/service";
import { getAccountConfig } from "@/lib/config";
import { configure, fixture } from "./helpers";
import { demoData } from "@/lib/demo";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function config(key: string) {
  mocks.costs.mockResolvedValue({ costs: {} });
  const raw = fixture("binance");
  raw.accounts[0].apiKey = key;
  const app = configure(raw);
  const c = getAccountConfig(app, "alice-account");
  return {
    ...c,
    DATABASE_URL: "postgresql://test.invalid/unit-test",
    PERFORMANCE_BASELINE_USDT: "50",
    PERFORMANCE_BASELINE_AT: "2026-01-01T00:00:00Z",
    PERFORMANCE_NET_FLOWS_USDT: "0",
  };
}
const base = {
  tickers: [],
  orders: [],
  trades: [],
  warnings: [],
  tradesComplete: true,
  ordersComplete: true,
};
describe("snapshot and valuation integrity", () => {
  it("shows buy-only fees while discovery is incomplete and clearly marks the value provisional", async () => {
    const c = config("buy-fees-during-sync");
    const data = demoData();
    data.tradesComplete = false;
    for (const market of Object.values(data.ledger!.markets)) {
      market.trades = market.trades.filter((t) => t.side === "BUY");
      for (const t of market.trades) {
        t.fee = "0.1";
        t.feeAsset = "USDT";
      }
    }
    mocks.load.mockResolvedValue(data);
    mocks.history.mockResolvedValue([]);
    const result = await dashboard(c);
    expect(result.summary).toMatchObject({
      realizedPnl: "-2",
      feePnl: "-2",
      realizedPnlComplete: false,
    });
    expect(result.summary.realizedPnlNote).toContain("暂计");
    expect(result.summary.realizedPnlNote).toContain("同步中");
  });
  it("keeps realized PnL independent of manual holding costs and their storage availability", async () => {
    const c = config("trade-realized-independent");
    mocks.load.mockResolvedValue(demoData());
    mocks.history.mockResolvedValue([]);
    mocks.costs.mockResolvedValue({ costs: { BTC: "58000", ETH: "2380", SOL: "136", BNB: "545" } });
    const before = await dashboard(c);
    expect(before.summary.realizedPnl).toBe("160");
    mocks.costs.mockResolvedValue({ costs: { BTC: "60000", ETH: "2380", SOL: "136", BNB: "545" } });
    const after = await dashboard(c);
    expect(after.summary.realizedPnl).toBe("160");
    expect(after.summary.unrealizedPnl).not.toBe(before.summary.unrealizedPnl);
    mocks.costs.mockRejectedValue(new Error("unavailable"));
    const failed = await dashboard(c);
    expect(failed.summary.realizedPnl).toBe("160");
    expect(failed.summary.unrealizedPnl).toBeNull();
    expect(failed.summary.realizedPnlNote).toContain("按成交核算");
  });
  it.each(["456.12345678", "0"])(
    "prefers exchange equity %s and saves it even with unpriced holdings",
    async (spotEquity) => {
      const c = config(`official-equity-${spotEquity}`);
      mocks.load.mockResolvedValue({
        ...base,
        spotEquity,
        balances: [
          { asset: "UNKNOWN", free: "1", locked: "0" },
          { asset: "USDT", free: "100", locked: "2" },
        ],
      });
      mocks.history.mockResolvedValue([]);
      const d = await dashboard(c, true);
      expect(d.summary).toMatchObject({
        equity: spotEquity,
        equitySource: "exchange",
        equityComplete: true,
        unpricedAssets: 1,
        cash: "102",
        unrealizedPnl: null,
      });
      expect(mocks.save).toHaveBeenCalledWith(c, expect.objectContaining({ equity: spotEquity }));
      expect(d.summary.totalPnl).not.toBeNull();
      expect(d.warnings.join(" ")).not.toContain("当前总额仅为已估值资产小计");
    },
  );
  it("uses manual costs immediately before history finishes and picks up edits without an upstream refresh", async () => {
    const c = config("manual-before-history-test");
    mocks.load.mockResolvedValue({
      ...base,
      tradesComplete: false,
      balances: [{ asset: "BTC", free: "1", locked: "0.5" }],
      tickers: [{ symbol: "BTCUSDT", lastPrice: "60000", priceChangePercent: "0" }],
    });
    mocks.history.mockResolvedValue([]);
    mocks.costs.mockResolvedValue({ costs: { BTC: "58000" } });
    const first = await dashboard(c);
    expect(first.holdings[0].averageCost).toBe("58000");
    expect(first.summary.unrealizedPnl).toBe("3000");
    expect(first.summary.realizedPnl).toBeNull();
    expect(first.summary.realizedPnlNote).toContain("成交历史同步中");
    mocks.costs.mockResolvedValue({ costs: { BTC: "59000" } });
    expect((await dashboard(c)).summary.unrealizedPnl).toBe("1500");
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });
  it("separates USDT cash, frozen funds and principal from other stablecoins and missing costs", async () => {
    const c = { ...config("cash-principal-test"), PRINCIPAL_USDT: "75" };
    mocks.load.mockResolvedValue({
      ...base,
      balances: [
        { asset: "USDT", free: "100", locked: "20" },
        { asset: "USDC", free: "50", locked: "0" },
      ],
      tickers: [{ symbol: "USDCUSDT", lastPrice: "0.99", priceChangePercent: "0" }],
    });
    mocks.history.mockResolvedValue([]);
    const d = await dashboard(c);
    expect(d.summary).toMatchObject({
      equity: "169.5",
      principal: "75",
      cash: "120",
      cashFree: "100",
      cashLocked: "20",
      stablecoinValue: "169.5",
      unrealizedPnl: "0",
      realizedPnl: null,
    });
  });
  it("does not save incomplete equity or calculate total PnL when an asset is unpriced", async () => {
    const c = config("unpriced-test");
    mocks.load.mockResolvedValue({
      ...base,
      balances: [
        { asset: "USDT", free: "100", locked: "0" },
        { asset: "UNKNOWN", free: "1", locked: "0" },
      ],
    });
    mocks.history.mockResolvedValue([]);
    const d = await dashboard(c, true);
    expect(d.summary.equity).toBe("100");
    expect(d.summary.equitySource).toBe("calculated");
    expect(d.summary.equityComplete).toBe(false);
    expect(d.summary.totalPnl).toBeNull();
    expect(d.summary.unpricedAssets).toBe(1);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(d.connection.snapshotsSaved).toBe(false);
  });
  it("retains current data when persistence fails and records the failure honestly", async () => {
    const c = config("database-failure-test");
    mocks.load.mockResolvedValue({
      ...base,
      balances: [{ asset: "USDT", free: "100", locked: "0" }],
    });
    mocks.save.mockRejectedValue(new Error("private connection string"));
    const d = await dashboard(c, true);
    expect(d.summary.equity).toBe("100");
    expect(d.summary.totalPnl).toBe("50");
    expect(d.connection.snapshotsSaved).toBe(false);
    expect(d.warnings.join(" ")).toContain("历史净值暂时不可用");
    expect(JSON.stringify(d)).not.toContain("private connection string");
  });
});
