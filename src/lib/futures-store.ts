import "server-only";
import { readFile, writeFile, mkdir, rename, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { Config } from "./config";
import { accountScope } from "./storage";
import { netTransferSchema, type FuturesSettings } from "./futures-schema";
import { AppError } from "./errors";
type Audit = {
  revision: string;
  at: number;
  by: string;
  before: string | null;
  after: string | null;
};
type Stored = FuturesSettings & { audit: Audit[] };
const ready = new Map<string, Promise<void>>();
const conflict = () =>
  new AppError("FUTURES_CONFLICT", "合约配置已被其他管理员修改，请重新加载后再保存。", 409);
function sqlFor(c: Config) {
  return neon(c.DATABASE_URL, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
}
async function initialize(c: Config) {
  if (!ready.has(c.DATABASE_URL))
    ready.set(
      c.DATABASE_URL,
      (async () => {
        const sql = sqlFor(c);
        await sql`CREATE TABLE IF NOT EXISTS slzb_futures_settings (account_id TEXT PRIMARY KEY, revision TEXT NOT NULL, data JSONB NOT NULL)`;
      })().catch((e) => {
        ready.delete(c.DATABASE_URL);
        throw e;
      }),
    );
  await ready.get(c.DATABASE_URL);
}
function fileFor(c: Config) {
  const hash = createHash("sha256").update(accountScope(c)).digest("hex");
  return resolve(/*turbopackIgnore: true*/ ".slzb", "futures-settings", `${hash}.json`);
}
function initial(c: Config): Stored {
  return {
    revision: null,
    netTransfer: null,
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
      await sql`SELECT data FROM slzb_futures_settings WHERE account_id = ${accountScope(c)}`;
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
  netTransferSchema.parse(data.netTransfer);
  return data;
}
export async function readFuturesSettings(c: Config): Promise<FuturesSettings> {
  const { audit: _, ...settings } = await readStored(c);
  return settings;
}
export async function writeFuturesSettings(
  c: Config,
  netTransfer: string | null,
  revision: string | null,
  actor: string,
): Promise<FuturesSettings> {
  netTransferSchema.parse(netTransfer);
  if (process.env.VERCEL && !c.DATABASE_URL)
    throw new AppError(
      "FUTURES_STORAGE_REQUIRED",
      "云端保存合约配置需要管理员先配置 DATABASE_URL。",
      503,
    );
  let release: (() => Promise<void>) | undefined;
  if (!c.DATABASE_URL) {
    await mkdir(/*turbopackIgnore: true*/ resolve(".slzb", "futures-settings"), {
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
      netTransfer,
      revision: nextRevision,
      updatedAt: at,
      updatedBy: actor,
      audit: [
        ...current.audit,
        { revision: nextRevision, at, by: actor, before: current.netTransfer, after: netTransfer },
      ].slice(-100),
    };
    if (c.DATABASE_URL) {
      const sql = sqlFor(c);
      const rows = revision
        ? await sql`UPDATE slzb_futures_settings SET revision = ${nextRevision}, data = ${JSON.stringify(next)}::jsonb WHERE account_id = ${accountScope(c)} AND revision = ${revision} RETURNING revision`
        : await sql`INSERT INTO slzb_futures_settings (account_id, revision, data) VALUES (${accountScope(c)}, ${nextRevision}, ${JSON.stringify(next)}::jsonb) ON CONFLICT DO NOTHING RETURNING revision`;
      if (!rows.length) throw conflict();
    } else {
      const target = fileFor(c),
        temporary = `${target}.${nextRevision}.tmp`;
      await writeFile(/*turbopackIgnore: true*/ temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(/*turbopackIgnore: true*/ temporary, /*turbopackIgnore: true*/ target);
    }
    const { audit: _, ...settings } = next;
    return settings;
  } finally {
    await release?.();
  }
}
