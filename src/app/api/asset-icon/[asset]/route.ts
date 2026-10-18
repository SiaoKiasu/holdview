import { assetSymbolPattern } from "@/lib/asset-symbol.mjs";

const catalog = "https://www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset";
const maxBytes = 256 * 1024;
const unavailable = (status = 404) =>
  new Response(null, {
    status,
    headers: { "Cache-Control": status === 404 ? "public, max-age=300" : "no-store" },
  });

// Public logo data only. No account credentials or arbitrary remote URLs are accepted.
export async function GET(_request: Request, context: { params: Promise<{ asset: string }> }) {
  const asset = (await context.params).asset.toUpperCase();
  if (!assetSymbolPattern.test(asset)) return unavailable(400);
  try {
    const metadata = await fetch(catalog, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!metadata.ok) return unavailable(502);
    const body = await metadata.json();
    if (body.code !== "000000" || !Array.isArray(body.data)) return unavailable(502);
    const entry = body.data.find((item: { assetCode?: string }) => item.assetCode === asset);
    if (!entry?.logoUrl) return unavailable();
    const url = new URL(entry.logoUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "bin.bnbstatic.com" ||
      url.port ||
      url.username ||
      url.password
    )
      return unavailable();
    const icon = await fetch(url, {
      next: { revalidate: 86400 },
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    const mime = icon.headers.get("content-type")?.split(";")[0];
    if (
      !icon.ok ||
      !["image/png", "image/webp", "image/jpeg"].includes(mime ?? "") ||
      Number(icon.headers.get("content-length") ?? 0) > maxBytes
    )
      return unavailable(502);
    const reader = icon.body?.getReader();
    if (!reader) return unavailable(502);
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return unavailable(502);
      }
      chunks.push(value);
    }
    if (!length) return unavailable(502);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new Response(bytes, {
      headers: {
        "Content-Type": mime!,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return unavailable(502);
  }
}
