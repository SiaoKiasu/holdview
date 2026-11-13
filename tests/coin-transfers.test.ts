import { it, expect, vi } from "vitest";
import { syncCoinTransfers } from "@/lib/coin-transfers";
import { BinanceClient } from "@/lib/binance";
it("resumes paginated transfer history, deduplicates recent overlap and keeps directions distinct", async () => {
  const now = Date.now();
  const request = vi.fn(async (path: string, p: Record<string, string>, signed: boolean) => {
    expect(path).toBe("/sapi/v1/asset/transfer");
    expect(signed).toBe(true);
    if (p.type === "CMFUTURE_MAIN" || Number(p.startTime) > now - 1000)
      return { total: 0, rows: [] };
    const start = (Number(p.current) - 1) * 100;
    return {
      total: 250,
      rows: Array.from({ length: Math.min(100, 250 - start) }, (_, j) => ({
        tranId: (9007199254740992n + BigInt(start + j)).toString(),
        asset: "BTC",
        amount: "0.001",
        type: "MAIN_CMFUTURE",
        status: "CONFIRMED",
        timestamp: now - 1000,
      })),
    };
  });
  const c = { request } as unknown as BinanceClient;
  const first = await syncCoinTransfers(c, undefined, now - 89 * 86400000, now, now + 60000);
  expect(first.complete).toBe(false);
  expect(first.rows).toHaveLength(200);
  expect(first.directions.MAIN_CMFUTURE!.pending!.page).toBe(3);
  const second = await syncCoinTransfers(c, first, now - 89 * 86400000, now + 1, now + 60000);
  expect(second.complete).toBe(true);
  expect(second.rows).toHaveLength(250);
  expect(new Set(second.rows.map((r) => r.tranId)).size).toBe(250);
});
it("does not treat failed requests or pending transfers as confirmed balances", async () => {
  const now = Date.now();
  const request = vi.fn(async () => ({
    total: 1,
    rows: [
      {
        tranId: "42",
        asset: "BTC",
        amount: "1",
        type: "MAIN_CMFUTURE",
        status: "PENDING",
        timestamp: now,
      },
    ],
  }));
  const result = await syncCoinTransfers(
    { request } as unknown as BinanceClient,
    undefined,
    now - 1000,
    now,
    now + 60000,
  );
  expect(result.rows).toHaveLength(0);
  const failed = await syncCoinTransfers(
    {
      request: async () => {
        throw Error("denied");
      },
    } as unknown as BinanceClient,
    undefined,
    now - 1000,
    now,
    now + 60000,
  );
  expect(failed.complete).toBe(false);
});
it("preserves SAPI 64-bit IDs on the actual JSON transport boundary", async () => {
  const fetcher = vi.fn(
    async () => new Response('{"rows":[{"tranId":9007199254740992},{"tranId":9007199254740993}]}'),
  ) as unknown as typeof fetch;
  const c = new BinanceClient(
    { BINANCE_ENV: "mainnet", BINANCE_API_KEY: "key", BINANCE_API_SECRET: "secret" },
    fetcher,
  );
  const result = (await c.request(
    "/sapi/v1/asset/transfer",
    { type: "MAIN_CMFUTURE" },
    true,
  )) as any;
  expect(result.rows.map((r: any) => r.tranId)).toEqual(["9007199254740992", "9007199254740993"]);
});
