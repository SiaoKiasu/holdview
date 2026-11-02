import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { getAccountConfig } from "@/lib/config";
import { accountScope } from "@/lib/storage";
import { readCosts, writeCosts } from "@/lib/cost-store";
import { configure, fixture } from "./helpers";
afterEach(() => vi.unstubAllEnvs());
it("persists authoritative costs, records audit, rejects stale edits and isolates accounts", async () => {
  vi.stubEnv("VERCEL", "");
  const c = {
    ...getAccountConfig(configure(fixture("binance")), "alice-account"),
    ACCOUNT_ID: `cost-test-${randomUUID()}`,
  };
  const hash = createHash("sha256").update(accountScope(c)).digest("hex");
  const file = resolve(".slzb", "costs", `${hash}.json`);
  try {
    const initial = await readCosts(c);
    expect(initial.revision).toBeNull();
    expect((await readCosts(c, true)).costs).toEqual(initial.costs);
    const saved = await writeCosts(c, { BTC: "58000" }, initial.revision, "alice");
    expect(await readCosts(c, true)).toEqual(saved);
    expect(await readCosts(c)).toEqual(saved);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(writeCosts(c, { BTC: "1" }, null, "stale-admin")).rejects.toMatchObject({
      status: 409,
    });
    const next = await writeCosts(c, { BTC: "59000", 牛来: "0.07453" }, saved.revision, "alice");
    expect((await readCosts(c)).costs.牛来).toBe("0.07453");
    expect(next.costs.BTC).toBe("59000");
    expect((await readCosts(c, true)).costs.BTC).toBe("59000");
    const disk = JSON.parse(await readFile(file, "utf8"));
    expect(disk.audit).toHaveLength(2);
    expect(disk.audit[1]).toMatchObject({
      by: "alice",
      before: { BTC: "58000" },
      after: { BTC: "59000", 牛来: "0.07453" },
    });
    expect((await readCosts({ ...c, ACCOUNT_ID: `${c.ACCOUNT_ID}-other` })).costs).toEqual({});
  } finally {
    await unlink(file).catch(() => undefined);
  }
});
it("refuses nonpersistent cloud writes", async () => {
  vi.stubEnv("VERCEL", "1");
  const c = getAccountConfig(configure(fixture("binance")), "alice-account");
  await expect(writeCosts(c, { BTC: "58000" }, null, "alice")).rejects.toMatchObject({
    status: 503,
  });
});
