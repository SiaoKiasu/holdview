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
          : u.pathname === "/fapi/v3/account"
            ? {
                totalMarginBalance: "160",
                assets: [
                  {
                    asset: "USDT",
                    marginBalance: "160",
                    walletBalance: "150",
                    availableBalance: "50",
                    initialMargin: "110",
                  },
                ],
              }
            : u.pathname === "/fapi/v1/userTrades"
              ? []
              : handler(u),
    );
  });
}
describe("read-only futures adapter", () => {
  it("reads USDT futures and deduplicates overlaps by income type and transaction ID", async () => {
    const t = transport(() => [income(1), income(1, "FUNDING_FEE")]);
    const result = await new BinanceFuturesClient(config, t as typeof fetch).loadFutures();
    expect(result.positions[0].entryPrice).toBe("50");
    expect(result.account?.equity).toBe("160");
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
  it("preserves 64-bit transaction IDs exactly without rejecting or merging adjacent IDs", async () => {
    const t = transport(() => []);
    const raw = `[${JSON.stringify(income(1)).replace('"tranId":1', '"tranId":9007199254740992')},${JSON.stringify(income(1)).replace('"tranId":1', '"tranId":9007199254740993')}]`;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) =>
      new URL(String(url)).pathname === "/fapi/v1/income"
        ? new Response(raw)
        : t(url, init)) as typeof fetch;
    const result = await new BinanceFuturesClient(config, fetcher).loadFutures();
    expect(result.complete).toBe(true);
    expect(result.ledger.incomes.map((i) => i.tranId)).toEqual([
      "9007199254740992",
      "9007199254740993",
    ]);
  });
  it("reads recent and historical contract trades and deduplicates by symbol and ID", async () => {
    const t = transport(() => []);
    const row = {
      id: "9007199254740993",
      symbol: "NEWUSDT",
      side: "BUY",
      price: "50",
      qty: "2",
      quoteQty: "100",
      commission: "0.1",
      commissionAsset: "USDT",
      time: 1,
      maker: true,
      realizedPnl: "0",
    };
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) =>
      new URL(String(url)).pathname === "/fapi/v1/userTrades"
        ? Response.json([row])
        : t(url, init)) as typeof fetch;
    const result = await new BinanceFuturesClient(config, fetcher).loadFutures();
    expect(result.trades).toHaveLength(1);
    expect(result.trades![0]).toMatchObject({
      instrument: "futures",
      id: row.id,
      quantity: "2",
      fee: "0.1",
    });
    expect(result.tradesComplete).toBe(true);
  });
  it("retains exchange equity and new fills when income history fails", async () => {
    const base = transport(() => {
      throw new Error("income unavailable");
    });
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(url)).pathname === "/fapi/v1/userTrades")
        return Response.json([
          {
            id: "71",
            symbol: "NEWUSDT",
            side: "BUY",
            price: "50",
            qty: "2",
            quoteQty: "100",
            commission: "0.1",
            commissionAsset: "USDT",
            time: Date.now(),
            maker: false,
            realizedPnl: "0",
          },
        ]);
      return base(url, init);
    }) as typeof fetch;
    const result = await new BinanceFuturesClient(config, fetcher).loadFutures();
    expect(result.account?.equity).toBe("160");
    expect(result.positions[0].unRealizedProfit).toBe("10");
    expect(result.complete).toBe(false);
    expect(result.trades?.[0].id).toBe("71");
    expect(result.tradesComplete).toBe(true);
  });
  it("continues a full same-millisecond trade page with exact ID cursor and keeps recent fills", async () => {
    const base = transport(() => []);
    const row = (id: number) => ({
      id: String(id),
      symbol: "NEWUSDT",
      side: "BUY",
      price: "50",
      qty: "2",
      quoteQty: "100",
      commission: "0.1",
      commissionAsset: "USDT",
      time: 1234,
      maker: false,
      realizedPnl: "0",
    });
    const cursors: string[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname !== "/fapi/v1/userTrades") return base(url, init);
      expect(u.searchParams.has("startTime")).toBe(false);
      expect(u.searchParams.has("endTime")).toBe(false);
      const from = u.searchParams.get("fromId");
      if (from === null) return Response.json([row(2001)]);
      cursors.push(from);
      return Response.json(
        from === "0" ? Array.from({ length: 1000 }, (_, i) => row(i + 1)) : [row(1001)],
      );
    }) as typeof fetch;
    const first = await new BinanceFuturesClient(config, fetcher).loadFutures();
    expect(first.tradesComplete).toBe(false);
    expect(first.trades).toHaveLength(1001);
    const second = await new BinanceFuturesClient(config, fetcher).loadFutures(first.ledger);
    expect(cursors).toEqual(["0", "1001"]);
    expect(second.trades).toHaveLength(1002);
    expect(second.tradesComplete).toBe(true);
  });
});

describe("futures open order coverage", () => {
  it("normalizes standard and conditional orders without losing large identifiers", async () => {
    const client = new BinanceFuturesClient(
      config,
      transport((u) => {
        if (u.pathname === "/fapi/v1/openOrders")
          return [
            {
              orderId: "9007199254740993111",
              symbol: "NEWUSDT",
              side: "BUY",
              type: "LIMIT",
              price: "50",
              origQty: "3",
              executedQty: "1",
              cumQuote: "49",
              status: "PARTIALLY_FILLED",
              time: 1,
              positionSide: "LONG",
              reduceOnly: false,
            },
          ];
        if (u.pathname === "/fapi/v1/openAlgoOrders")
          return [
            {
              algoId: "9007199254740993222",
              symbol: "NEWUSDT",
              side: "SELL",
              orderType: "STOP_MARKET",
              price: "0",
              quantity: "2",
              triggerPrice: "45",
              algoStatus: "NEW",
              createTime: 2,
              positionSide: "LONG",
              reduceOnly: true,
              closePosition: false,
            },
          ];
        return [];
      }),
    );
    const data = await client.loadFutures();
    expect(data.ordersComplete).toBe(true);
    expect(data.orders).toHaveLength(2);
    expect(data.orders?.[0]).toMatchObject({
      id: "9007199254740993111",
      instrument: "futures",
      quantity: "3",
      executedQuantity: "1",
      executedQuote: "49",
    });
    expect(data.orders?.[1]).toMatchObject({
      id: "algo-9007199254740993222",
      type: "STOP_MARKET",
      stopPrice: "45",
      price: "0",
      reduceOnly: true,
    });
  });
  it("keeps successful orders and marks coverage incomplete if conditional orders fail", async () => {
    const client = new BinanceFuturesClient(
      config,
      transport((u) => {
        if (u.pathname === "/fapi/v1/openAlgoOrders") throw Error("unavailable");
        if (u.pathname === "/fapi/v1/openOrders")
          return [
            {
              orderId: "1",
              symbol: "NEWUSDT",
              side: "BUY",
              type: "LIMIT",
              price: "50",
              origQty: "3",
              executedQty: "0",
              status: "NEW",
              time: 1,
            },
          ];
        return [];
      }),
    );
    const data = await client.loadFutures();
    expect(data.ordersComplete).toBe(false);
    expect(data.orders).toHaveLength(1);
    expect(data.warnings.join("")).toContain("合约条件单读取失败");
  });
});
