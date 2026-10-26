import { describe, expect, it } from "vitest";
import { formatPrice } from "@/lib/price-format";

describe("micro-price display", () => {
  it.each([
    ["0.00000437", "0.0₅437"],
    ["0.000004370123", "0.0₅437"],
    ["0.0000043768", "0.0₅4377"],
    ["0.0000437", "0.0₄437"],
    ["4.37e-9", "0.0₈437"],
    [0.00000437, "0.0₅437"],
    ["0.0000000000012345", "0.0₁₁1235"],
    ["1e-400", "0.0₃₉₉1"],
    ["-0.00000437", "−0.0₅437"],
  ])("preserves zero count and significant digits for %s", (value, expected) => {
    expect(formatPrice(value)).toBe(expected);
  });
  it.each([
    ["0.0000099999", "0.0₄1"],
    ["0.000099999", "0.0001"],
    ["-0.000099999", "−0.0001"],
    ["0.00009999", "0.0₄9999"],
    ["0.0001", "0.0001"],
    ["0", "0.00"],
    ["0.7", "0.7000"],
    ["1", "1.00"],
    ["81520.319", "81,520.32"],
  ])("handles rounding and display boundaries for %s", (value, expected) => {
    expect(formatPrice(value)).toBe(expected);
  });
  it.each([null, "invalid", "NaN", Infinity, "Infinity"])(
    "handles missing or invalid values",
    (value) => {
      expect(formatPrice(value)).toBe("—");
    },
  );
});
