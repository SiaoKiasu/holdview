import Decimal from "decimal.js";

const subscriptDigits = "₀₁₂₃₄₅₆₇₈₉";

export function formatPrice(value: string | number | null): string {
  if (value === null) return "—";
  let price: Decimal;
  try {
    price = new Decimal(value);
  } catch {
    return "—";
  }
  if (!price.isFinite()) return "—";
  const abs = price.abs();
  if (!abs.isZero() && abs.lt("0.0001")) {
    // The subscript counts consecutive zeros after the decimal point.
    // Round before counting, so a carry cannot leave a stale zero count.
    const rounded = abs.toSignificantDigits(4, Decimal.ROUND_HALF_UP);
    const sign = price.isNegative() ? "−" : "";
    if (rounded.gte("0.0001")) return `${sign}0.0001`;
    const zeros = String(-rounded.e - 1)
      .split("")
      .map((digit) => subscriptDigits[Number(digit)])
      .join("");
    const significant = rounded.toExponential().split("e")[0].replace(".", "");
    return `${sign}0.0${zeros}${significant}`;
  }
  const n = price.toNumber();
  if (!Number.isFinite(n)) return "—";
  const digits = abs.gt(0) && abs.lt(1) ? 4 : 2;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
