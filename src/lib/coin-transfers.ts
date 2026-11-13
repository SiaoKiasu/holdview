import "server-only";
import { z } from "zod";
import type { BinanceClient } from "./binance";
import type { CoinTransferHistory } from "./types";
import { transactionId, decimal } from "./binance-futures";
const DAY = 86400000;
const schema = z.object({
  total: z.number(),
  rows: z
    .array(
      z.object({
        tranId: transactionId,
        asset: z.string(),
        amount: decimal,
        type: z.enum(["MAIN_CMFUTURE", "CMFUTURE_MAIN"]),
        status: z.string(),
        timestamp: z.number(),
      }),
    )
    .default([]),
});
// Verify that DAPI TRANSFER events really move between the two wallets in scope.
// Both historical pagination and the latest window are bounded; cursors persist in
// the same ledger and never add database reads or market-poll requests.
export async function syncCoinTransfers(
  client: BinanceClient,
  previous: CoinTransferHistory | undefined,
  startTime: number,
  now: number,
  until: number,
): Promise<CoinTransferHistory> {
  const state: CoinTransferHistory = structuredClone(previous ?? { rows: [], directions: {} });
  state.complete = true;
  const rows = new Map(state.rows.map((r) => [r.type + ":" + r.tranId, r]));
  for (const type of ["MAIN_CMFUTURE", "CMFUTURE_MAIN"] as const) {
    const cursor = (state.directions[type] ??= { through: startTime });
    try {
      const read = async (start: number, end: number, page: number) => {
        if (Date.now() > until - 1000) throw Error("deadline");
        const result = schema.parse(
          await client.request(
            "/sapi/v1/asset/transfer",
            {
              type,
              startTime: String(start),
              endTime: String(end),
              current: String(page),
              size: "100",
            },
            true,
          ),
        );
        for (const r of result.rows)
          if (r.status === "CONFIRMED") rows.set(r.type + ":" + r.tranId, r);
        return result.total;
      };
      await read(Math.max(startTime, now - 7 * DAY), now, 1);
      cursor.pending ??= { start: Math.max(startTime, cursor.through - DAY), end: now, page: 1 };
      for (let i = 0; i < 2 && cursor.pending; i++) {
        const w = cursor.pending!;
        const total = await read(w.start, w.end, w.page);
        if (w.page * 100 >= total) {
          cursor.through = w.end;
          delete cursor.pending;
          if (cursor.through < now)
            cursor.pending = { start: cursor.through + 1, end: now, page: 1 };
        } else w.page++;
      }
      if (cursor.pending || cursor.through < now) state.complete = false;
    } catch {
      state.complete = false;
    }
  }
  state.rows = [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
  return state;
}
