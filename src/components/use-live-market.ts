"use client";
import { useEffect, useMemo, useState } from "react";
import type { Dashboard } from "@/lib/types";
import { liveValuation, MARKET_REFRESH_MS, type MarketQuotes } from "@/lib/live-valuation";
export function useLiveMarket(base: Dashboard | null, enabled: boolean) {
  const [quotes, setQuotes] = useState<MarketQuotes | null>(null);
  const environment = base?.environment.includes("Testnet") ? "testnet" : "mainnet";
  const timestamp = base?.updatedAt;
  const source = base?.source;
  const symbols = [
    ...new Set([
      ...(base?.holdings
        .filter((h) => h.instrument !== "futures" && h.asset !== "USDT")
        .flatMap((h) => ["USDT", "BTC", "ETH", "USDC"].map((quote) => h.asset + quote)) ?? []),
      ...(base?.positionDetails?.map((p) => p.symbol) ?? []),
      ...(base?.coinWallets?.map((w) => w.asset + "USDT") ?? []),
      "BTCUSDT",
      "ETHUSDT",
      "USDCUSDT",
    ]),
  ]
    .sort()
    .join(",");
  useEffect(() => {
    setQuotes(null);
    if (!enabled || !timestamp || source !== "binance") return;
    let stopped = false,
      pending = false;
    let controller: AbortController | undefined;
    const refresh = async () => {
      if (document.hidden || stopped || pending) return;
      pending = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8000);
      try {
        const response = await fetch(
          `/api/market?environment=${environment}&symbols=${encodeURIComponent(symbols)}`,
          {
            credentials: "omit",
            signal: controller.signal,
          },
        );
        if (!response.ok) return;
        const next = await response.json();
        if (!stopped && next.environment === environment) setQuotes(next);
      } catch {
        /* Keep the last quote and show its age; never substitute zero prices. */
      } finally {
        clearTimeout(timeout);
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, MARKET_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, timestamp, source, environment, symbols]);
  return useMemo(() => (base ? liveValuation(base, quotes) : null), [base, quotes]);
}
