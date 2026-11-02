import "server-only";
import { readFile, writeFile, mkdir, rename, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { Config } from "./config";
import { accountScope } from "./storage";
import { demoCosts } from "./demo";
import { costValuesSchema, type CostSettings } from "./cost-schema";
import { AsyncCache } from "./async-cache";
import { AppError } from "./errors";
type Audit = {
  revision: string;
  at: number;
  by: string;
  before: Record<string, string>;
  after: Record<string, string>;
};
type Stored = CostSettings & { audit: Audit[] };
const costCache = new AsyncCache<CostSettings>(60000);
function cacheKey(c: Config) {
  return createHash("sha256")
    .update(JSON.stringify([c.DATABASE_URL, accountScope(c), c.DATA_SOURCE, c.costs]))
    .digest("hex");
}
const ready = new Map<string, Promise<void>>();
const conflict = () =>
  new AppError("COST_CONFLICT", "成本已被其他管理员修改，请重新加载后再保存。", 409);
function sqlFor(c: Config) {
  return neon(c.DATABASE_URL, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
}
async function initialize(c: Config) {
  if (!ready.has(c.DATABASE_URL))
    ready.set(
      c.DATABASE_URL,
      (async () => {
        const sql = sqlFor(c);
        await sql`CREATE TABLE IF NOT EXISTS slzb_cost_settings (account_id TEXT PRIMARY KEY, revision TEXT NOT NULL, data JSONB NOT NULL)`;
      })().catch((e) => {
        ready.delete(c.DATABASE_URL);
        throw e;
      }),
    );
  await ready.get(c.DATABASE_URL);
}
function fileFor(c: Config) {
  const hash = createHash("sha256").update(accountScope(c)).digest("hex");
  return resolve(/*turbopackIgnore: true*/ ".slzb", "costs", `${hash}.json`);
}
function initial(c: Config): Stored {
  return {
    revision: null,
    costs: c.DATA_SOURCE === "demo" ? { ...demoCosts, ...c.costs } : c.costs,
    updatedAt: null,
    updatedBy: null,
    audit: [],
  };
}
async function readStored(c: Config): Promise<Stored> {
  let data: Stored;
  if (c.DATABASE_URL) {
    await initialize(c);
    const sql = sqlFor(c);
    const rows =
      await sql`SELECT data FROM slzb_cost_settings WHERE account_id = ${accountScope(c)}`;
    if (!rows.length) return initial(c);
    data = rows[0].data;
  } else if (process.env.VERCEL) return initial(c);
  else {
    try {
      data = JSON.parse(await readFile(/*turbopackIgnore: true*/ fileFor(c), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return initial(c);
      throw e;
    }
  }
  costValuesSchema.parse(data.costs);
  return data;
}
export async function readCosts(c: Config, cached = false): Promise<CostSettings> {
  const read = async () => {
    const { audit: _, ...settings } = await readStored(c);
    return settings;
  };
  // Editing always reads storage. Only dashboard reads opt in to the short cache.
  return cached ? costCache.get(cacheKey(c), read) : read();
}
export async function writeCosts(
  c: Config,
  costs: Record<string, string>,
  revision: string | null,
  actor: string,
): Promise<CostSettings> {
  costValuesSchema.parse(costs);
  if (process.env.VERCEL && !c.DATABASE_URL)
    throw new AppError("COST_STORAGE_REQUIRED", "云端保存成本需要管理员先配置 DATABASE_URL。", 503);
  let release: (() => Promise<void>) | undefined;
  if (!c.DATABASE_URL) {
    await mkdir(/*turbopackIgnore: true*/ resolve(".slzb", "costs"), {
      recursive: true,
      mode: 0o700,
    });
    const lock = `${fileFor(c)}.lock`;
    try {
      const handle = await open(/*turbopackIgnore: true*/ lock, "wx", 0o600);
      release = async () => {
        await handle.close();
        await unlink(/*turbopackIgnore: true*/ lock);
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw conflict();
      throw e;
    }
  }
  try {
    const current = await readStored(c);
    if (revision !== current.revision) throw conflict();
    const nextRevision = randomUUID(),
      at = Date.now();
    const next: Stored = {
      costs,
      revision: nextRevision,
      updatedAt: at,
      updatedBy: actor,
      audit: [
        ...current.audit,
        { revision: nextRevision, at, by: actor, before: current.costs, after: costs },
      ].slice(-100),
    };
    if (c.DATABASE_URL) {
      const sql = sqlFor(c);
      const rows = revision
        ? await sql`UPDATE slzb_cost_settings SET revision = ${nextRevision}, data = ${JSON.stringify(next)}::jsonb WHERE account_id = ${accountScope(c)} AND revision = ${revision} RETURNING revision`
        : await sql`INSERT INTO slzb_cost_settings (account_id, revision, data) VALUES (${accountScope(c)}, ${nextRevision}, ${JSON.stringify(next)}::jsonb) ON CONFLICT DO NOTHING RETURNING revision`;
      if (!rows.length) throw conflict();
    } else {
      const target = fileFor(c),
        temporary = `${target}.${nextRevision}.tmp`;
      await writeFile(/*turbopackIgnore: true*/ temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(/*turbopackIgnore: true*/ temporary, /*turbopackIgnore: true*/ target);
    }
    costCache.invalidate(cacheKey(c));
    const { audit: _, ...settings } = next;
    return settings;
  } finally {
    await release?.();
  }
}
