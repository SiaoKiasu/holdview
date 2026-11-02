import { afterEach, expect, it, vi } from "vitest";
const sql = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => [] as Record<string, unknown>[]));
vi.mock("@neondatabase/serverless", () => ({ neon: () => sql }));
import { readHistory, saveSnapshot } from "@/lib/storage";
import { configure } from "./helpers";
import { getAccountConfig } from "@/lib/config";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("reuses history, deduplicates snapshot writes and isolates account/database scopes", async () => {
  const c = {
    ...getAccountConfig(configure(), "alice-account"),
    DATABASE_URL: "postgres://fake/cache",
  };
  await Promise.all([readHistory(c), readHistory(c)]);
  const count = (pattern: string) =>
    sql.mock.calls.filter((args) => (args[0] as unknown as string[]).join("").includes(pattern))
      .length;
  expect(count("SELECT")).toBe(1);
  await Promise.all([
    saveSnapshot(c, { time: 600001, equity: "100" }),
    saveSnapshot(c, { time: 600002, equity: "101" }),
  ]);
  expect(count("INSERT")).toBe(1);
  await readHistory(c);
  expect(count("SELECT")).toBe(2);
  await saveSnapshot(c, { time: 600003, equity: "102" });
  expect(count("INSERT")).toBe(1);
  await saveSnapshot(c, { time: 900001, equity: "103" });
  expect(count("INSERT")).toBe(2);
  await readHistory({ ...c, ACCOUNT_ID: "other" });
  await readHistory({ ...c, DATABASE_URL: "postgres://fake/other" });
  expect(count("SELECT")).toBe(4);
});
