import Decimal from "decimal.js";
import { STABLECOINS } from "./assets";
import type { Dashboard } from "./types";
export type QuoteBatch = { time: number; prices: Record<string, string> };
export type MarketQuotes = {
  environment: "mainnet" | "testnet";
  spot: QuoteBatch | null;
  futures: QuoteBatch | null;
};
export const ACCOUNT_REFRESH_MS = 10 * 60 * 1000;
export const MARKET_REFRESH_MS = 5000;
const D = (v: string | number) => new Decimal(v);

// Always reprice the last authenticated account snapshot, never the prior repriced result.
// Cash, fills, fees, funding, quantities and stored history remain authoritative snapshots.
export function liveValuation(
  base: Dashboard,
  quotes: MarketQuotes | null,
  now = Date.now(),
): Dashboard {
  if (
    !quotes ||
    base.source === "demo" ||
    quotes.environment !== (base.environment.includes("Testnet") ? "testnet" : "mainnet")
  )
    return base;
  const usable = (batch: QuoteBatch | null) =>
    batch && batch.time > base.updatedAt && batch.time > now - 30000 && batch.time <= now + 10000
      ? batch
      : null;
  const spot = usable(quotes.spot),
    futures = usable(quotes.futures);
  if (!spot && !futures) return base;
  const price = (batch: QuoteBatch | null, symbol: string) => {
    const raw = batch?.prices[symbol];
    if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return null;
    const d = D(raw);
    return d.isFinite() && d.gt(0) ? d : null;
  };
  const spotPrice = (asset: string) => {
    if (asset === "USDT") return D(1);
    const direct = price(spot, `${asset}USDT`);
    if (direct) return direct;
    for (const bridge of ["BTC", "ETH", "USDC"]) {
      const p = price(spot, `${asset}${bridge}`),
        q = price(spot, `${bridge}USDT`);
      if (p && q) return p.mul(q);
    }
    return null;
  };
  let complete = true,
    spotDelta = D(0),
    spotPnlDelta = D(0),
    futuresDelta = D(0);
  let changed = false;
  const spotByAsset = new Map<string, Decimal>(),
    futureByAsset = new Map<string, Decimal>();
  const positions = base.positionDetails?.map((p) => {
    const mark = price(futures, p.symbol);
    if (!mark || p.marginAsset !== "USDT" || !p.symbol.endsWith("USDT") || D(p.markPrice).lte(0)) {
      complete = false;
      return p;
    }
    changed = true;
    const delta = mark.minus(p.markPrice).mul(p.positionAmt);
    futuresDelta = futuresDelta.plus(delta);
    const asset = p.symbol.slice(0, -4);
    futureByAsset.set(asset, (futureByAsset.get(asset) ?? D(0)).plus(delta));
    return {
      ...p,
      markPrice: mark.toString(),
      unRealizedProfit: D(p.unRealizedProfit).plus(delta).toString(),
    };
  });
  let holdings = base.holdings.map((h) => {
    if (h.instrument === "futures") {
      const ps = positions?.filter((p) => p.symbol === h.symbol) ?? [];
      if (!ps.length) return h;
      const delta = futureByAsset.get(h.asset);
      if (delta === undefined) return h;
      const notional = ps.reduce((v, p) => v.plus(D(p.positionAmt).abs().mul(p.markPrice)), D(0));
      const qty = D(h.quantity),
        basis = qty.mul(h.averageCost ?? 0);
      const pnl = h.unrealizedPnl === null ? null : D(h.unrealizedPnl).plus(delta);
      return {
        ...h,
        price: qty.gt(0) ? notional.div(qty).toString() : h.price,
        value: notional.toString(),
        unrealizedPnl: pnl?.toString() ?? null,
        returnRate: pnl && basis.gt(0) ? pnl.div(basis).mul(100).toString() : null,
      };
    }
    if (h.asset === "USDT") return h;
    const p = spotPrice(h.asset);
    // No known starting value means an exchange-wallet delta cannot be reconstructed safely.
    if (!p || h.value === null || h.price === null) {
      complete = false;
      return h;
    }
    changed = true;
    const value = p.mul(h.quantity),
      delta = value.minus(h.value);
    spotDelta = spotDelta.plus(delta);
    spotByAsset.set(h.asset, delta);
    if (!STABLECOINS.has(h.asset)) spotPnlDelta = spotPnlDelta.plus(delta);
    return {
      ...h,
      price: p.toString(),
      value: value.toString(),
      unrealizedPnl: h.unrealizedPnl === null ? null : D(h.unrealizedPnl).plus(delta).toString(),
    };
  });
  if (!changed)
    return {
      ...base,
      marketUpdatedAt: Math.max(spot?.time ?? 0, futures?.time ?? 0),
      marketComplete: complete,
    };
  const equityDelta = spotDelta.plus(base.summary.futuresEquity == null ? 0 : futuresDelta),
    pnlDelta = spotPnlDelta.plus(futuresDelta);
  const equity = D(base.summary.equity).plus(equityDelta);
  holdings = holdings.map((h) => ({
    ...h,
    allocation: equity.gt(0)
      ? D(h.value ?? 0)
          .div(equity)
          .mul(100)
          .toNumber()
      : 0,
  }));
  const add = (v: string | null | undefined, delta: Decimal) =>
    v == null ? v : D(v).plus(delta).toString();
  const hedgePeriods = Object.fromEntries(
    Object.entries(base.hedgePeriods ?? {}).map(([asset, p]) => {
      const sd = spotByAsset.get(asset) ?? D(0),
        fd = futureByAsset.get(asset) ?? D(0);
      return [
        asset,
        {
          ...p,
          spotPnl: add(p.spotPnl, sd)!,
          futuresPnl: add(p.futuresPnl, fd)!,
          netPnl: add(p.netPnl, sd.plus(fd))!,
        },
      ];
    }),
  );
  return {
    ...base,
    holdings,
    positionDetails: positions,
    hedgePeriods,
    marketUpdatedAt: Math.max(spot?.time ?? 0, futures?.time ?? 0),
    marketComplete: complete,
    summary: {
      ...base.summary,
      equity: equity.toString(),
      equitySource: "calculated",
      futuresEquity: add(base.summary.futuresEquity, futuresDelta),
      unrealizedPnl: add(base.summary.unrealizedPnl, pnlDelta)!,
      totalPnl: add(base.summary.totalPnl, equityDelta)!,
      stablecoinValue: holdings
        .filter((h) => h.instrument !== "futures" && STABLECOINS.has(h.asset))
        .reduce((v, h) => v.plus(h.value ?? 0), D(0))
        .toString(),
    },
  };
}
