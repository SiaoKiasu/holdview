import { describe, it, expect, vi } from "vitest";
import { BinanceFuturesClient } from "@/lib/binance-futures";
import type { FuturesLedger } from "@/lib/types";
const config = {
  BINANCE_ENV: "mainnet" as const,
  BINANCE_API_KEY: "read-key",
  BINANCE_API_SECRET: "secret",
};
const pos = {
  symbol: "NEWUSDT",
  positionSide: "BOTH",
  positionAmt: "2",
  entryPrice: "50",
  markPrice: "55",
  unRealizedProfit: "10",
  marginAsset: "USDT",
};
const income = (id: number, type = "COMMISSION") => ({
  tranId: id,
  symbol: "NEWUSDT",
  incomeType: type,
  income: "-0.1",
  asset: "USDT",
  time: Date.now() - 1000,
});
function transport(handler: (u: URL) => unknown) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(init?.method).toBe("GET");
    if (u.pathname !== "/fapi/v1/time") {
      expect(u.searchParams.get("signature")).toMatch(/^[a-f0-9]{64}$/);
      expect((init?.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe("read-key");
    }
    return Response.json(
      u.pathname === "/fapi/v1/time"
        ? { serverTime: Date.now() }
        : u.pathname === "/fapi/v3/positionRisk"
          ? [pos]
          : handler(u),
    );
  });
}
describe("read-only futures adapter", () => {
  it("reads USDT futures and deduplicates overlaps by income type and transaction ID", async () => {
    const t = transport(() => [income(1), income(1, "FUNDING_FEE")]);
    const result = await new BinanceFuturesClient(config, t as typeof fetch).loadFutures();
    expect(result.positions[0].entryPrice).toBe("50");
    expect(result.ledger.incomes).toHaveLength(2);
    expect(result.complete).toBe(true);
    expect(t.mock.calls.every(([u]) => new URL(String(u)).host === "fapi.binance.com")).toBe(true);
    const again = await new BinanceFuturesClient(config, t as typeof fetch).loadFutures(
      result.ledger,
    );
    expect(again.ledger.incomes).toHaveLength(2);
  });
  it("keeps testnet credentials on futures testnet", async () => {
    const t = transport(() => []);
    await new BinanceFuturesClient(
      { ...config, BINANCE_ENV: "testnet" },
      t as typeof fetch,
    ).loadFutures();
    expect(t.mock.calls.every(([u]) => new URL(String(u)).host === "demo-fapi.binance.com")).toBe(
      true,
    );
  });
  it("continues bounded backfill without losing newest fees", async () => {
    const now = Date.now();
    const previous: FuturesLedger = {
      incomes: [],
      startTime: now - 50 * 86400000,
      syncedThrough: 0,
      feeRates: {},
      pending: { startTime: now - 50 * 86400000, endTime: now - 20 * 86400000, page: 4 },
    };
    const t = transport((u) =>
      Number(u.searchParams.get("endTime")) === previous.pending!.endTime
        ? Array.from({ length: 1000 }, (_, n) =>
            income(10000 * Number(u.searchParams.get("page")) + n),
          )
        : [income(999999)],
    );
    const result = await new BinanceFuturesClient(config, t as typeof fetch).loadFutures(previous);
    expect(result.complete).toBe(false);
    expect(result.ledger.pending?.page).toBe(9);
    expect(result.ledger.incomes.some((i) => i.tranId === "999999")).toBe(true);
    expect(previous.pending!.page).toBe(4);
  });
  it("does not treat an income failure as zero income or lose persisted fees", async () => {
    const t = transport(() => {
      throw new Error("unavailable");
    });
    const previous: FuturesLedger = {
      incomes: [{ ...income(1), tranId: "1" }],
      startTime: Date.now() - 1000,
      syncedThrough: Date.now() - 1000,
      feeRates: {},
    };
    const result = await new BinanceFuturesClient(config, t as typeof fetch).loadFutures(previous);
    expect(result.complete).toBe(false);
    expect(result.ledger.incomes).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it("refuses malformed positions and unsafe transaction IDs", async () => {
    const t = transport(() => [{ ...income(1), tranId: Number.MAX_SAFE_INTEGER + 1 }]);
    const result = await new BinanceFuturesClient(config, t as typeof fetch).loadFutures();
    expect(result.complete).toBe(false);
    expect(result.ledger.incomes).toEqual([]);
  });
});
