export function formatPrice(value: string | number | null): string {
  if (value === null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value),
    abs = Math.abs(n);
  const digits = abs > 0 && abs < 1 ? 4 : 2;
  // Do not render a nonzero micro-price as a literal zero.
  if (abs > 0 && abs < 0.00005) return `${n < 0 ? "−" : ""}<0.0001`;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
