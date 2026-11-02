import "server-only";
import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import type { Config } from "./config";
import { AsyncCache } from "./async-cache";
import type { Snapshot } from "./types";
const ready = new Map<string, Promise<void>>();
const historyCache = new AsyncCache<Snapshot[]>(300000);
const snapshotCache = new AsyncCache<boolean>(300000);
function cacheKey(c: Config) {
  return createHash("sha256")
    .update(c.DATABASE_URL + ":" + accountScope(c))
    .digest("hex");
}
function database(c: Config) {
  return neon(c.DATABASE_URL, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
}
export function accountScope(c: Config) {
  // An API-key fingerprint prevents accidentally mixing snapshots after swapping keys.
  return `${c.ACCOUNT_ID}:${c.BINANCE_ENV}:${createHash("sha256").update(c.BINANCE_API_KEY).digest("hex").slice(0, 24)}`;
}
async function initialize(c: Config) {
  if (!ready.has(c.DATABASE_URL))
    ready.set(
      c.DATABASE_URL,
      (async () => {
        const sql = database(c);
        await sql`CREATE TABLE IF NOT EXISTS slzb_snapshots (account_id TEXT NOT NULL, bucket BIGINT NOT NULL, observed_at BIGINT NOT NULL, equity NUMERIC(38, 12) NOT NULL, PRIMARY KEY (account_id, bucket))`;
      })().catch((e) => {
        ready.delete(c.DATABASE_URL);
        throw e;
      }),
    );
  await ready.get(c.DATABASE_URL);
}
export async function saveSnapshot(c: Config, point: Snapshot) {
  const bucket = Math.floor(point.time / 300000) * 300000;
  const key = cacheKey(c);
  return snapshotCache.get(`${key}:${bucket}`, async () => {
    await initialize(c);
    const sql = database(c);
    // One persisted observation per five-minute bucket, including across cold instances.
    await sql`INSERT INTO slzb_snapshots (account_id, bucket, observed_at, equity) VALUES (${accountScope(c)}, ${bucket}, ${point.time}, ${point.equity}) ON CONFLICT (account_id, bucket) DO NOTHING`;
    historyCache.invalidate(key);
    return true;
  });
}
export async function readHistory(c: Config): Promise<Snapshot[]> {
  return historyCache.get(cacheKey(c), async () => {
    await initialize(c);
    const sql = database(c);
    const rows =
      await sql`SELECT DISTINCT ON (floor(observed_at / 3600000.0)) observed_at, equity FROM slzb_snapshots WHERE account_id = ${accountScope(c)} AND observed_at >= ${Date.now() - 90 * 86400000} ORDER BY floor(observed_at / 3600000.0), observed_at DESC`;
    return rows.map((r) => ({ time: Number(r.observed_at), equity: String(r.equity) }));
  });
}
