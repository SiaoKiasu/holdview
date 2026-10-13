import Decimal from "decimal.js";
import type { ProviderData, Holding, Trade } from "./types";
import { feeRateKey } from "./trade-pnl";
import { STABLECOINS } from "./assets";

Decimal.set({ precision: 36 });
const D = (v: Decimal.Value = 0) => new Decimal(v);
export type ClosingFill = {
  id: string;
  time: number;
  quantity: string;
  entryPrice: string | null;
  exitPrice: string;
  cost: string | null;
  grossPnl: string | null;
  fees: string | null;
  netPnl: string | null;
  returnRate: string | null;
  holdingMs: number | null;
};
export type ClosedReviewRow = {
  id: string;
  asset: string;
  market: "spot" | "futures";
  status: "closed" | "partial" | "unknown";
  remainingValue: string | null;
  quantity: string;
  averageEntry: string | null;
  averageExit: string;
  cost: string | null;
  grossPnl: string | null;
  fees: string | null;
  netPnl: string | null;
  returnRate: string | null;
  holdingMs: number | null;
  lastCloseAt: number;
  closeCount: number;
  complete: boolean;
  fills: ClosingFill[];
};
export type ClosedReview = { rows: ClosedReviewRow[]; complete: boolean };
type Inventory = {
  qty: Decimal;
  cost: Decimal;
  fees: Decimal | null;
  weightedTime: Decimal;
  valid: boolean;
};
const empty = (): Inventory => ({ qty: D(), cost: D(), fees: D(), weightedTime: D(), valid: true });
const add = (a: Decimal | null, b: Decimal | null) => (a === null || b === null ? null : a.plus(b));
const sum = (fills: ClosingFill[], key: "cost" | "fees" | "grossPnl" | "netPnl") =>
  fills.reduce<Decimal | null>((n, f) => add(n, f[key] === null ? null : D(f[key]!)), D());
const ordered = (trades: Trade[]) =>
  [...new Map(trades.map((t) => [`${t.symbol}:${t.id}`, t])).values()].sort(
    (a, b) =>
      a.time - b.time || a.symbol.localeCompare(b.symbol) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
  );

// Separate analytical view: allocate entry commissions only to closed units. This does not
// alter the dashboard's cash-flow accounting (which expenses commissions when incurred).
export function closedReview(data: ProviderData, holdings: Holding[]): ClosedReview {
  const groups = new Map<
    string,
    { asset: string; market: "spot" | "futures"; fills: ClosingFill[]; complete: boolean }
  >();
  const record = (
    asset: string,
    market: "spot" | "futures",
    fill: ClosingFill,
    complete: boolean,
  ) => {
    const key = `${market}:${asset}`;
    if (!groups.has(key)) groups.set(key, { asset, market, fills: [], complete });
    const g = groups.get(key)!;
    g.complete &&= complete;
    g.fills.push(fill);
  };
  const feeValue = (t: Trade, base: string, futures: boolean): Decimal | null => {
    const fee = D(t.fee);
    if (fee.isZero()) return D();
    if (t.feeAsset === "USDT") return fee;
    if (!futures && t.feeAsset === base && D(t.quantity).gt(0))
      return fee.mul(t.quoteQuantity).div(t.quantity);
    const key = feeRateKey(t.feeAsset, t.time);
    const rate = futures ? data.futures?.ledger.feeRates[key] : data.ledger?.feeRates?.[key]?.price;
    return rate && D(rate).gt(0) ? fee.mul(rate) : null;
  };
  function open(p: Inventory, qty: Decimal, cost: Decimal, fee: Decimal | null, at: number) {
    p.qty = p.qty.plus(qty);
    p.cost = p.cost.plus(cost);
    p.fees = add(p.fees, fee);
    p.weightedTime = p.weightedTime.plus(qty.mul(at));
  }
  function close(
    p: Inventory,
    t: Trade,
    qty: Decimal,
    disposed: Decimal,
    fee: Decimal | null,
    exchangeGross?: Decimal,
    baseFeeValue = D(),
  ): ClosingFill {
    const matched = p.valid && p.qty.gte(disposed) && p.qty.gt(0);
    const ratio = matched ? disposed.div(p.qty) : D();
    const cost = matched ? p.cost.mul(ratio) : null;
    const entryFee = matched && p.fees !== null ? p.fees.mul(ratio) : null;
    const gross =
      exchangeGross ?? (cost === null ? null : D(t.quoteQuantity).minus(cost).plus(baseFeeValue));
    const fees = add(entryFee, fee);
    const net = gross !== null && fees !== null ? gross.minus(fees) : null;
    const holdingMs = matched
      ? Math.max(0, D(t.time).minus(p.weightedTime.div(p.qty)).toNumber())
      : null;
    const result: ClosingFill = {
      id: `${t.symbol}:${t.id}`,
      time: t.time,
      quantity: qty.toString(),
      entryPrice: cost !== null ? cost.div(disposed).toString() : null,
      exitPrice: t.price,
      cost: cost?.toString() ?? null,
      grossPnl: gross?.toString() ?? null,
      fees: fees?.toString() ?? null,
      netPnl: net?.toString() ?? null,
      returnRate: net !== null && cost?.gt(0) ? net.div(cost).mul(100).toString() : null,
      holdingMs,
    };
    if (matched) {
      p.qty = p.qty.minus(disposed);
      p.cost = p.cost.minus(cost!);
      p.fees = p.fees !== null && entryFee !== null ? p.fees.minus(entryFee) : null;
      p.weightedTime = p.weightedTime.mul(D(1).minus(ratio));
      if (p.qty.isZero()) Object.assign(p, empty());
    } else {
      Object.assign(p, empty(), { valid: false });
    }
    return result;
  }
  const spot = new Map<string, Inventory>();
  const inventory = (asset: string) => {
    if (!spot.has(asset)) spot.set(asset, empty());
    return spot.get(asset)!;
  };
  const metadata = new Map(Object.entries(data.ledger?.markets ?? {}));
  const trades = ordered([...metadata.values()].flatMap((m) => m.trades));
  for (const t of trades) {
    const m = metadata.get(t.symbol)!;
    if (m.quoteAsset !== "USDT") {
      inventory(m.baseAsset).valid = false;
      continue;
    }
    const p = inventory(m.baseAsset),
      q = D(t.quantity),
      quote = D(t.quoteQuantity);
    if (q.lte(0)) continue;
    const baseFee = t.feeAsset === m.baseAsset ? D(t.fee) : D();
    const baseFeeValue = baseFee.mul(quote).div(q);
    const fee = feeValue(t, m.baseAsset, false);
    if (t.side === "BUY") {
      if (q.lte(baseFee)) {
        p.valid = false;
        continue;
      }
      open(p, q.minus(baseFee), quote.minus(baseFeeValue), fee, t.time);
    } else {
      const fill = close(p, t, q, q.plus(baseFee), fee, undefined, baseFeeValue);
      if (!STABLECOINS.has(m.baseAsset))
        record(m.baseAsset, "spot", fill, data.tradesComplete && m.complete);
    }
    // Commission paid in a third token also consumes its inventory, without a sale.
    if (t.feeAsset !== m.baseAsset && t.feeAsset !== "USDT" && D(t.fee).gt(0)) {
      const paid = inventory(t.feeAsset),
        spent = D(t.fee);
      if (paid.qty.gte(spent) && paid.qty.gt(0)) {
        const remaining = D(1).minus(spent.div(paid.qty));
        paid.cost = paid.cost.mul(remaining);
        paid.fees = paid.fees?.mul(remaining) ?? null;
        paid.weightedTime = paid.weightedTime.mul(remaining);
        paid.qty = paid.qty.minus(spent);
      } else paid.valid = false;
    }
  }
  const futures = new Map<string, { p: Inventory; direction: number }>();
  for (const t of ordered(data.futures?.trades ?? [])) {
    if (!t.symbol.endsWith("USDT")) continue;
    const asset = t.symbol.slice(0, -4),
      key = `${t.symbol}:${t.positionSide ?? "BOTH"}`;
    if (!futures.has(key)) futures.set(key, { p: empty(), direction: 0 });
    const state = futures.get(key)!,
      p = state.p;
    const q = D(t.quantity),
      sign = t.side === "BUY" ? 1 : -1;
    if (q.lte(0)) continue;
    const fee = feeValue(t, asset, true);
    const hedgeClose =
      t.positionSide === "LONG" ? sign < 0 : t.positionSide === "SHORT" ? sign > 0 : false;
    const closing =
      hedgeClose ||
      (state.direction !== 0 && state.direction !== sign) ||
      (p.qty.isZero() &&
        D(t.realizedPnl ?? 0)
          .abs()
          .gt(0));
    if (!closing) {
      open(p, q, q.mul(t.price), fee, t.time);
      state.direction = sign;
      continue;
    }
    const closed = hedgeClose ? q : p.qty.gt(0) ? Decimal.min(q, p.qty) : q;
    const portionFee = fee?.mul(closed).div(q) ?? null;
    const fill = close(
      p,
      t,
      closed,
      closed,
      portionFee,
      t.realizedPnl === undefined ? undefined : D(t.realizedPnl),
    );
    record(
      asset,
      "futures",
      fill,
      data.futures?.tradesComplete === true && !data.futures?.ledger.historyGap,
    );
    const remainder = q.minus(closed);
    if (remainder.gt(0) && !hedgeClose) {
      Object.assign(p, empty());
      open(p, remainder, remainder.mul(t.price), fee?.mul(remainder).div(q) ?? null, t.time);
      state.direction = sign;
    } else if (p.qty.isZero()) state.direction = 0;
  }
  const rows: ClosedReviewRow[] = [...groups]
    .map<ClosedReviewRow>(([id, g]) => {
      const quantity = g.fills.reduce((n, f) => n.plus(f.quantity), D());
      const cost = sum(g.fills, "cost"),
        net = sum(g.fills, "netPnl");
      const related = holdings.filter(
        (h) => (h.instrument ?? "spot") === g.market && h.asset === g.asset,
      );
      const positionsKnown = g.market === "spot" || data.futures?.positionsComplete !== false;
      const value =
        !positionsKnown || related.some((h) => h.value === null)
          ? null
          : related.reduce((n, h) => n.plus(h.value ?? 0), D());
      const entryKnown = g.fills.every((f) => f.entryPrice !== null);
      return {
        id,
        asset: g.asset,
        market: g.market,
        status: value === null ? "unknown" : value.lt(1) ? "closed" : "partial",
        remainingValue: value?.toString() ?? null,
        quantity: quantity.toString(),
        averageEntry: entryKnown
          ? g.fills
              .reduce((n, f) => n.plus(D(f.quantity).mul(f.entryPrice!)), D())
              .div(quantity)
              .toString()
          : null,
        averageExit: g.fills
          .reduce((n, f) => n.plus(D(f.quantity).mul(f.exitPrice)), D())
          .div(quantity)
          .toString(),
        cost: cost?.toString() ?? null,
        grossPnl: sum(g.fills, "grossPnl")?.toString() ?? null,
        fees: sum(g.fills, "fees")?.toString() ?? null,
        netPnl: net?.toString() ?? null,
        returnRate: net !== null && cost?.gt(0) ? net.div(cost).mul(100).toString() : null,
        holdingMs: g.fills.every((f) => f.holdingMs !== null)
          ? g.fills
              .reduce((n, f) => n.plus(D(f.quantity).mul(f.holdingMs!)), D())
              .div(quantity)
              .toNumber()
          : null,
        lastCloseAt: g.fills[g.fills.length - 1].time,
        closeCount: g.fills.length,
        complete: g.complete && net !== null && value !== null,
        fills: [...g.fills].reverse().slice(0, 100),
      };
    })
    .sort((a, b) => b.lastCloseAt - a.lastCloseAt);
  return {
    rows,
    complete:
      data.tradesComplete &&
      (!data.futures || data.futures.tradesComplete === true) &&
      rows.every((r) => r.complete),
  };
}
