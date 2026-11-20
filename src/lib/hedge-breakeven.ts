import Decimal from "decimal.js";
import type { PositionGroup } from "./exposure";
const D = Decimal.clone({ precision: 36 });

/** Same-price theoretical root: owned-coin PnL + all open-contract PnL = 0.
 * Excludes settled income, fees and funding. USD/USDT parity and unchanged
 * positions are assumed; this is not a liquidation or execution simulation.
 */
export function hedgeBreakEvenPrice(g: PositionGroup): string | null {
  if (!g.hedged || g.stable) return null;
  const spotQty = new D(g.spotQuantity);
  // marginBalance includes unsettled inverse PnL, which is modeled below.
  const walletQty = new D(g.collateralWallet?.walletBalance ?? 0);
  if (spotQty.isNegative() || walletQty.isNegative()) return null;
  const quantity = spotQty.plus(walletQty);
  if (!quantity.gt(0)) return null;
  if (
    (spotQty.gt(0) && g.spot?.averageCost == null) ||
    (walletQty.gt(0) && g.collateralWallet?.averageCost == null)
  )
    return null;
  const cost = spotQty
    .mul(g.spot?.averageCost ?? 0)
    .plus(walletQty.mul(g.collateralWallet?.averageCost ?? 0));
  let slope = quantity;
  let intercept = cost.neg();
  for (const p of g.positions) {
    const entry = new D(p.entryPrice);
    if (!entry.gt(0)) return null;
    if (p.contractMarket === "coin") {
      if (
        p.marginAsset !== g.asset ||
        p.baseAsset !== g.asset ||
        p.contracts == null ||
        p.contractSize == null ||
        !new D(p.contractSize).gt(0)
      )
        return null;
      // Signed USD face N: native PnL = N*(1/entry - 1/P).
      // At the target price P, its USD value is N*(P/entry - 1).
      const face = new D(p.contracts).mul(p.contractSize);
      slope = slope.plus(face.div(entry));
      intercept = intercept.minus(face);
    } else {
      if (p.marginAsset !== "USDT") return null;
      const q = new D(p.positionAmt);
      slope = slope.plus(q);
      intercept = intercept.minus(q.mul(entry));
    }
  }
  // A price-neutral combination has either no root or infinitely many.
  if (slope.isZero()) return null;
  const price = intercept.neg().div(slope);
  if (!price.isFinite() || !price.gt(0)) return null;
  // Reject roots where coin appreciation covers a losing hedge: the requested
  // price must instead have hedge profit offsetting an owned-coin loss.
  if (quantity.mul(price).gt(cost)) return null;
  return price.toString();
}
