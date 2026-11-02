import "server-only";
import { z } from "zod";
import { AsyncCache } from "./async-cache";
import type { MarketQuotes } from "./live-valuation";

const positive = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .refine((v) => Number(v) >= 0 && Number.isFinite(Number(v)));
const spotSchema = z.array(z.object({ symbol: z.string(), price: positive }));
const futuresSchema = z.array(
  z.object({ symbol: z.string(), markPrice: positive, time: z.number() }),
);
const cache = new AsyncCache<MarketQuotes>(4000, 2);
export function marketQuotes(environment: "mainnet" | "testnet"): Promise<MarketQuotes> {
  return cache.get(environment, async () => {
    const spotHost =
      environment === "mainnet"
        ? "https://data-api.binance.vision"
        : "https://testnet.binance.vision";
    const futuresHost =
      environment === "mainnet" ? "https://fapi.binance.com" : "https://demo-fapi.binance.com";
    const fetchJson = async (url: string) => {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error("Market unavailable");
      return response.json();
    };
    const [spot, futures] = await Promise.allSettled([
      fetchJson(`${spotHost}/api/v3/ticker/price`).then((raw) => ({
        prices: Object.fromEntries(
          spotSchema
            .parse(raw)
            .filter((p) => Number(p.price) > 0)
            .map((p) => [p.symbol, p.price]),
        ),
        time: Date.now(),
      })),
      fetchJson(`${futuresHost}/fapi/v1/premiumIndex`).then((raw) => {
        const now = Date.now();
        const rows = futuresSchema
          .parse(raw)
          .filter((p) => Number(p.markPrice) > 0 && p.time > now - 30000 && p.time <= now + 10000);
        if (!rows.length) throw new Error("Stale marks");
        return {
          prices: Object.fromEntries(rows.map((p) => [p.symbol, p.markPrice])),
          time: Math.min(...rows.map((p) => p.time)),
        };
      }),
    ]);
    if (spot.status === "rejected" && futures.status === "rejected")
      throw new Error("Market unavailable");
    return {
      environment,
      spot: spot.status === "fulfilled" ? spot.value : null,
      futures: futures.status === "fulfilled" ? futures.value : null,
    };
  });
}
