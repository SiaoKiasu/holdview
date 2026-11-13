import Decimal from "decimal.js";
import type { FuturesPosition, FuturesIncome } from "./types";
export const incomeIdentity = (
  i: Pick<FuturesIncome, "incomeType" | "tranId" | "contractMarket">,
) => `${i.contractMarket === "coin" ? "coin:" : ""}${i.incomeType}:${i.tranId}`;
export const positionAsset = (p: FuturesPosition) =>
  p.baseAsset ?? (p.symbol.endsWith("USDT") ? p.symbol.slice(0, -4) : p.symbol);
export const supportedPosition = (p: FuturesPosition) =>
  p.contractMarket === "coin"
    ? !!p.baseAsset && !!p.contracts && Number(p.contractSize) > 0 && Number(p.settlementPrice) > 0
    : p.marginAsset === "USDT" && p.symbol.endsWith("USDT");
export const positionBasis = (p: FuturesPosition) =>
  p.contractMarket === "coin"
    ? new Decimal(p.contracts!).abs().mul(p.contractSize!).div(p.entryPrice).mul(p.settlementPrice!)
    : new Decimal(p.positionAmt).abs().mul(p.entryPrice);
export const contractLabel = (p: FuturesPosition) =>
  p.contractMarket === "coin"
    ? `币本位 · ${p.contractType === "PERPETUAL" ? "永续" : p.symbol.split("_").at(-1)}`
    : "U 本位 · 永续";

export const positionNotional = (p: FuturesPosition) =>
  new Decimal(p.positionAmt)
    .abs()
    .mul(p.contractMarket === "coin" ? p.settlementPrice! : p.markPrice);
