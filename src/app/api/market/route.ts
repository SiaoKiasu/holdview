import { marketQuotes } from "@/lib/market-quotes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;
// Public exchange prices only. No account identifiers, cookies, API keys or database access.
export async function GET(request: Request) {
  const environment = new URL(request.url).searchParams.get("environment") ?? "mainnet";
  if (environment !== "mainnet" && environment !== "testnet")
    return Response.json({ error: "Invalid environment" }, { status: 400 });
  const requested = new URL(request.url).searchParams.get("symbols");
  const symbols = requested?.split(",");
  if (symbols && (symbols.length > 256 || symbols.some((s) => !/^[\p{L}\p{N}_]{1,40}$/u.test(s))))
    return Response.json({ error: "Invalid symbols" }, { status: 400 });
  try {
    const quotes = await marketQuotes(environment);
    const filter = (batch: typeof quotes.spot) =>
      !batch || !symbols
        ? batch
        : {
            ...batch,
            prices: Object.fromEntries(
              symbols
                .filter((s) => Object.hasOwn(batch.prices, s))
                .map((s) => [s, batch.prices[s]]),
            ),
          };
    return Response.json(
      { ...quotes, spot: filter(quotes.spot), futures: filter(quotes.futures) },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=4",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch {
    return Response.json(
      { error: "行情暂时不可用" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
