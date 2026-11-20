import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { hedgeBreakEvenPrice } from "@/lib/hedge-breakeven";
import type { PositionGroup } from "@/lib/exposure";
import type { FuturesPosition } from "@/lib/types";
const linear = (q = "-2"): FuturesPosition => ({
  symbol: "BTCUSDT",
  positionSide: "BOTH",
  positionAmt: q,
  entryPrice: "80",
  markPrice: "70",
  unRealizedProfit: "20",
  marginAsset: "USDT",
});
const group = (): PositionGroup =>
  ({
    asset: "BTC",
    hedged: true,
    stable: false,
    spotQuantity: "1",
    spot: { averageCost: "100" },
    positions: [linear()],
  }) as PositionGroup;
const inverse = (): FuturesPosition => ({
  ...linear(),
  contractMarket: "coin",
  baseAsset: "BTC",
  symbol: "BTCUSD_PERP",
  marginAsset: "BTC",
  contracts: "-2",
  contractSize: "100",
  entryPrice: "80",
});
describe("hedge combination break-even", () => {
  it("finds a price where short profit exactly covers owned-coin loss", () => {
    expect(hedgeBreakEvenPrice(group())).toBe("60");
  });
  it("does not mistake a coin rally paying for a hedge loss for the requested root", () => {
    const g = group();
    g.positions = [linear("-0.5")];
    expect(hedgeBreakEvenPrice(g)).toBeNull(); // mathematical root is 120
  });
  it("returns no price for neutral combinations, including infinitely many roots", () => {
    const g = group();
    g.positions = [linear("-1")];
    expect(hedgeBreakEvenPrice(g)).toBeNull();
    g.positions[0].entryPrice = "100";
    expect(hedgeBreakEvenPrice(g)).toBeNull();
  });
  it("uses inverse face and entry, not mark-equivalent quantity or margin equity", () => {
    const g = group();
    g.spotQuantity = "0";
    g.collateralWallet = {
      asset: "BTC",
      walletBalance: "1",
      averageCost: "100",
      marginBalance: "9",
      unrealizedProfit: "8",
      price: "70",
      availableBalance: "0",
      initialMargin: "0",
    };
    g.positions = [inverse()];
    const price = new Decimal(hedgeBreakEvenPrice(g)!);
    const nativeShortGain = new Decimal(200).mul(
      new Decimal(1).div(price).minus(new Decimal(1).div(80)),
    );
    expect(price.minus(100).plus(nativeShortGain.mul(price)).abs().lt("1e-15")).toBe(true);
    g.positions[0].markPrice = "50";
    g.positions[0].positionAmt = "-4";
    expect(hedgeBreakEvenPrice(g)).toBe(price.toString());
  });
  it("combines multiple linear and inverse legs with owned collateral exactly once", () => {
    const g = group();
    g.positions = [inverse(), linear("1"), linear("-0.5")];
    expect(hedgeBreakEvenPrice(g)).toBe("60"); // slope -1, constant 60
  });
  it("returns a dash for missing costs, unhedged positions and nonpositive roots", () => {
    const g = group();
    g.spot!.averageCost = null;
    expect(hedgeBreakEvenPrice(g)).toBeNull();
    g.spot!.averageCost = "200";
    expect(hedgeBreakEvenPrice(g)).toBeNull();
    g.hedged = false;
    expect(hedgeBreakEvenPrice(g)).toBeNull();
  });
  it("excludes settlement fees, funding and exchange break-even from price-only root", () => {
    const g = group();
    g.fundingPnl = "1000";
    g.positions[0].breakEvenPrice = "12345";
    expect(hedgeBreakEvenPrice(g)).toBe("60");
  });
});
