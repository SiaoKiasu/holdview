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
const mocks = vi.hoisted(() => ({ save: vi.fn(), equities: new Map<string, string>() }));
vi.mock("@/lib/storage", () => ({ saveSnapshot: mocks.save }));
vi.mock("@/lib/binance", () => ({
  BinanceClient: class {
    constructor(private config: { ACCOUNT_ID: string }) {}
    async loadBalances() {
      return {
        spotEquity: mocks.equities.get(this.config.ACCOUNT_ID),
        balances: [
          {
            asset: "USDT",
            free: this.config.ACCOUNT_ID === "alice-account" ? "101" : "202",
            locked: "0",
          },
        ],
        tickers: [],
      };
    }
  },
}));
import { GET } from "@/app/api/cron/route";
import { configure, fixture } from "./helpers";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  mocks.equities.clear();
});
function cronRequest(query = "") {
  configure(fixture("binance"));
  vi.stubEnv("DATABASE_URL", "postgresql://test.invalid/test");
  vi.stubEnv("CRON_SECRET", "c".repeat(32));
  return new Request(`https://portal.test/api/cron${query}`, {
    headers: { authorization: `Bearer ${"c".repeat(32)}` },
  });
}
describe("multi-account snapshots", () => {
  it("saves each account with its own configuration and equity", async () => {
    const r = await GET(cronRequest());
    expect(r.status).toBe(200);
    expect(mocks.save.mock.calls.map(([c, point]) => [c.ACCOUNT_ID, point.equity]).sort()).toEqual([
      ["alice-account", "101"],
      ["bob-account", "202"],
    ]);
  });
  it("uses each account exchange equity for scheduled snapshots, including zero", async () => {
    mocks.equities.set("alice-account", "123.456");
    mocks.equities.set("bob-account", "0");
    const r = await GET(cronRequest());
    expect(r.status).toBe(200);
    expect(mocks.save.mock.calls.map(([c, point]) => [c.ACCOUNT_ID, point.equity]).sort()).toEqual([
      ["alice-account", "123.456"],
      ["bob-account", "0"],
    ]);
  });
  it("supports admin-only account filtering", async () => {
    expect((await GET(cronRequest("?accountId=bob-account"))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0][0].ACCOUNT_ID).toBe("bob-account");
  });
  it("reports partial failures without losing successful accounts or leaking secrets", async () => {
    mocks.save.mockImplementation(async (c) => {
      if (c.ACCOUNT_ID === "bob-account") throw new Error("secret connection string");
    });
    const r = await GET(cronRequest());
    expect(r.status).toBe(503);
    const text = await r.text();
    expect(text).not.toContain("secret connection string");
    expect(JSON.parse(text).results).toEqual(
      expect.arrayContaining([
        { accountId: "alice-account", saved: true },
        { accountId: "bob-account", saved: false },
      ]),
    );
  });
});
