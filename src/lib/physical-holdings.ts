import Decimal from "decimal.js";
import type { Dashboard, Holding } from "./types";
const D = (v: Decimal.Value) => new Decimal(v);
export type PhysicalHolding = Holding & { spotQuantity: string; walletQuantity: string };
// View only. Never feed these merged rows back into equity, risk exposure or order
// planning: the CM wallet is already included in exchange marginBalance.
export function physicalHoldings(data: Dashboard): PhysicalHolding[] {
  const rows = new Map<string, PhysicalHolding>(
    data.holdings
      .filter((h) => h.instrument !== "futures")
      .map((h) => [h.asset, { ...h, spotQuantity: h.quantity, walletQuantity: "0" }]),
  );
  for (const w of data.coinWallets ?? []) {
    const h = rows.get(w.asset),
      q = D(h?.quantity ?? 0).plus(w.walletBalance);
    if (q.lte(0)) continue;
    const value = h?.value === null ? null : D(h?.value ?? 0).plus(D(w.walletBalance).mul(w.price));
    const basisKnown =
      (!h || h.averageCost !== null) && (D(w.walletBalance).isZero() || w.averageCost != null);
    const basis = D(h?.quantity ?? 0)
      .mul(h?.averageCost ?? 0)
      .plus(D(w.walletBalance).mul(w.averageCost ?? 0));
    const pnlKnown = (!h || h.unrealizedPnl !== null) && w.holdingPnl != null;
    rows.set(w.asset, {
      ...(h ?? { asset: w.asset, free: "0", locked: "0", change24h: null }),
      spotQuantity: h?.quantity ?? "0",
      walletQuantity: w.walletBalance,
      quantity: q.toString(),
      averageCost: basisKnown ? basis.div(q).toString() : null,
      value: value?.toString() ?? null,
      price: value ? value.div(q).toString() : null,
      unrealizedPnl: pnlKnown
        ? D(h?.unrealizedPnl ?? 0)
            .plus(w.holdingPnl!)
            .toString()
        : null,
      allocation:
        value && D(data.summary.equity).gt(0)
          ? value.div(data.summary.equity).mul(100).toNumber()
          : 0,
    });
  }
  return [...rows.values()].sort((a, b) => D(b.value ?? 0).cmp(a.value ?? 0));
}
