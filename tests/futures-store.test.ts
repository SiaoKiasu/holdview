import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { getAccountConfig } from "@/lib/config";
import { accountScope } from "@/lib/storage";
import { readFuturesSettings, writeFuturesSettings } from "@/lib/futures-store";
import { configure, fixture } from "./helpers";
afterEach(() => vi.unstubAllEnvs());
it("persists net transfers, records audit, rejects stale edits and isolates accounts", async () => {
  vi.stubEnv("VERCEL", "");
  const c = {
    ...getAccountConfig(configure(fixture("binance")), "alice-account"),
    ACCOUNT_ID: `futures-test-${randomUUID()}`,
  };
  const hash = createHash("sha256").update(accountScope(c)).digest("hex");
  const file = resolve(".slzb", "futures-settings", `${hash}.json`);
  try {
    const initial = await readFuturesSettings(c);
    expect(initial.revision).toBeNull();
    const saved = await writeFuturesSettings(c, "150", initial.revision, "alice");
    expect(await readFuturesSettings(c)).toEqual(saved);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(writeFuturesSettings(c, "1", null, "stale-admin")).rejects.toMatchObject({
      status: 409,
    });
    const next = await writeFuturesSettings(c, "100", saved.revision, "alice");
    expect((await readFuturesSettings(c)).netTransfer).toBe("100");
    expect(next.netTransfer).toBe("100");
    const disk = JSON.parse(await readFile(file, "utf8"));
    expect(disk.audit).toHaveLength(2);
    expect(disk.audit[1]).toMatchObject({
      by: "alice",
      before: "150",
      after: "100",
    });
    expect(
      (await readFuturesSettings({ ...c, ACCOUNT_ID: `${c.ACCOUNT_ID}-other` })).netTransfer,
    ).toBeNull();
  } finally {
    await unlink(file).catch(() => undefined);
  }
});
it("refuses nonpersistent cloud writes", async () => {
  vi.stubEnv("VERCEL", "1");
  const c = getAccountConfig(configure(fixture("binance")), "alice-account");
  await expect(writeFuturesSettings(c, "150", null, "alice")).rejects.toMatchObject({
    status: 503,
  });
});
