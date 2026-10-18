"use client";

import { useState } from "react";

// Locally bundled exchange icons remain available without third-party browser requests.
const bundled: Record<string, string> = {
  BTC: "btc.png",
  ETH: "eth.png",
  SOL: "sol.png",
  BNB: "bnb.png",
  USDT: "usdt.png",
  USDC: "usdc.png",
  ZEC: "zec.png",
  AERO: "aero.png",
  牛来: "niulai.png",
  PONS: "pons.webp",
};

export function CoinIcon({ asset, compact = false }: { asset: string; compact?: boolean }) {
  const symbol = asset.trim().toUpperCase();
  const source = Object.hasOwn(bundled, symbol)
    ? `/coins/${bundled[symbol]}`
    : `/api/asset-icon/${encodeURIComponent(symbol)}`;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <span className={`coin${compact ? " coin-compact" : ""}`} aria-hidden="true">
      <span>{Array.from(symbol)[0]}</span>
      {failedSource !== source && (
        <img
          key={source}
          src={source}
          alt=""
          width={compact ? 25 : 31}
          height={compact ? 25 : 31}
          loading="lazy"
          decoding="async"
          onError={() => setFailedSource(source)}
        />
      )}
    </span>
  );
}
