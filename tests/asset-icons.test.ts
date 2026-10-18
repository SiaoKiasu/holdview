import { afterEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/asset-icon/[asset]/route";
const context = (asset: string) => ({ params: Promise.resolve({ asset }) });
const request = new Request("https://portal.test/api/asset-icon/TEST");
afterEach(() => vi.unstubAllGlobals());

it("matches exchange asset codes exactly, including Chinese symbols, and caches the image", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        code: "000000",
        data: [{ assetCode: "牛来", logoUrl: "https://bin.bnbstatic.com/image/coin.png" }],
      }),
    )
    .mockResolvedValueOnce(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const response = await GET(request, context("牛来"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toContain("max-age=86400");
  expect((await response.arrayBuffer()).byteLength).toBe(4);
});

it("does not guess a logo for an unknown symbol", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ code: "000000", data: [] }));
  vi.stubGlobal("fetch", fetcher);
  expect((await GET(request, context("NEWCOIN"))).status).toBe(404);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects remote URLs as asset inputs and untrusted catalog image URLs", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({
        code: "000000",
        data: [{ assetCode: "TEST", logoUrl: "https://bin.bnbstatic.com.evil.test/icon.png" }],
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  expect((await GET(request, context("https://localhost"))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await GET(request, context("TEST"))).status).toBe(404);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["text/html", "image/svg+xml"])("rejects non-raster upstream content: %s", async (mime) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          code: "000000",
          data: [{ assetCode: "TEST", logoUrl: "https://bin.bnbstatic.com/image/coin.png" }],
        }),
      )
      .mockResolvedValueOnce(new Response("untrusted", { headers: { "content-type": mime } })),
  );
  expect((await GET(request, context("TEST"))).status).toBe(502);
});

it("bounds image size even without a content-length header", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          code: "000000",
          data: [{ assetCode: "TEST", logoUrl: "https://bin.bnbstatic.com/image/coin.png" }],
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(256 * 1024 + 1), {
          headers: { "content-type": "image/png" },
        }),
      ),
  );
  expect((await GET(request, context("TEST"))).status).toBe(502);
});

it("fails gracefully when the metadata service is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const response = await GET(request, context("TEST"));
  expect(response.status).toBe(502);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
