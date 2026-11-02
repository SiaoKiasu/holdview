import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/runtime-config", () => ({
  loadAppConfig: () => {
    throw Error("Market must not read private config");
  },
}));
vi.mock("@/lib/directory-store", () => ({
  readDirectory: () => {
    throw Error("Market must not access database");
  },
}));
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(200000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("serves only requested public prices, shares requests and refreshes after expiry", async () => {
  const fetcher = vi.fn(async (url: string) =>
    Response.json(
      url.includes("premiumIndex")
        ? [
            { symbol: "BTCUSDT", markPrice: "101", time: Date.now() },
            { symbol: "OLDUSDT", markPrice: "5", time: 1 },
          ]
        : [
            { symbol: "BTCUSDT", price: "100" },
            { symbol: "ZEROUSDT", price: "0" },
            { symbol: "ETHUSDT", price: "10" },
          ],
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const { GET } = await import("@/app/api/market/route");
  const request = () =>
    new Request("http://localhost/api/market?symbols=BTCUSDT", {
      headers: { cookie: "private-account" },
    });
  const [a, b] = await Promise.all([GET(request()), GET(request())]);
  const data = await a.json();
  expect(data.spot.prices).toEqual({ BTCUSDT: "100" });
  expect(data.futures.prices).toEqual({ BTCUSDT: "101" });
  expect(b.status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(a.headers.get("cache-control")).toContain("s-maxage=4");
  for (const call of fetcher.mock.calls) {
    expect(String(call[0])).not.toContain("private-account");
  }
  vi.advanceTimersByTime(4001);
  await GET(request());
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it("rejects untrusted targets and does not replace a failed market with zero prices", async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes("premiumIndex")) throw Error("offline");
    return Response.json([{ symbol: "BTCUSDT", price: "100" }]);
  });
  vi.stubGlobal("fetch", fetcher);
  const { GET } = await import("@/app/api/market/route");
  expect(
    (await GET(new Request("http://localhost/api/market?environment=https://evil"))).status,
  ).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
  const response = await GET(new Request("http://localhost/api/market"));
  expect((await response.json()).futures).toBeNull();
});
