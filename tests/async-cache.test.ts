import { afterEach, expect, it, vi } from "vitest";
import { AsyncCache } from "@/lib/async-cache";
afterEach(() => vi.useRealTimers());
it("deduplicates concurrent reads, isolates callers and expires", async () => {
  vi.useFakeTimers();
  const c = new AsyncCache<{ n: number }>(1000),
    read = vi.fn(async () => ({ n: 1 }));
  const [a, b] = await Promise.all([c.get("a", read), c.get("a", read)]);
  a.n = 3;
  expect(b.n).toBe(1);
  expect((await c.get("a", read)).n).toBe(1);
  expect(read).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1001);
  await c.get("a", read);
  expect(read).toHaveBeenCalledTimes(2);
  await c.get("b", read);
  expect(read).toHaveBeenCalledTimes(3);
});
it("does not restore stale in-flight data after invalidation and never caches failures", async () => {
  const c = new AsyncCache<number>(1000);
  let release!: (v: number) => void;
  const pending = c.get(
    "a",
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await Promise.resolve();
  c.invalidate("a");
  await c.get("a", async () => 2);
  release(1);
  await pending;
  expect(await c.get("a", async () => 3)).toBe(2);
  await expect(
    c.get("fail", async () => {
      throw Error("offline");
    }),
  ).rejects.toThrow();
  expect(await c.get("fail", async () => 4)).toBe(4);
});
