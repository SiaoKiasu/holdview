import Decimal from "decimal.js";
import { valueHoldings } from "./portfolio";
import { STABLECOINS } from "./assets";
import type { ProviderData, TradeLedger } from "./types";

const D = (v: string | number) => new Decimal(v);
export type HedgeAnchor = {
  startedAt: number;
  spotQuantity: string;
  spotValue: string;
  futuresFloating: string;
  // Boundary IDs avoid charging fills already present in the starting snapshot.
  spotTradeIds: string[];
  incomeIds: string[];
};
export type HedgePeriod = {
  startedAt: number;
  spotPnl: string | null;
  futuresPnl: string | null;
  fundingPnl: string | null;
  feePnl: string | null;
  netPnl: string | null;
  complete: boolean;
  note: string;
};
const incomeId = (i: { incomeType: string; tranId: string }) => `${i.incomeType}:${i.tranId}`;
const tradeId = (t: { symbol: string; id: string }) => `${t.symbol}:${t.id}`;
const minute = (a: string, t: number) => `${a}:${Math.floor(t / 60000) * 60000}`;

// Stored alongside the existing trade ledger: no extra polling, table or DB round-trip.
// Starting point is first observed exposure, never a fabricated historical hedge start.
export function trackHedges(data: ProviderData, now: number): Record<string, HedgePeriod> {
  const ledger = data.ledger;
  const futures = data.futures;
  if (!ledger || !futures || futures.positionsComplete !== true) return {};
  const anchors = (ledger.hedgeAnchors ??= {});
  const spots = valueHoldings(data.balances, data.tickers, {});
  const assets = new Set(
    futures.positions
      .filter(
        (p) => D(p.positionAmt).lt(0) && p.marginAsset === "USDT" && p.symbol.endsWith("USDT"),
      )
      .map((p) => p.symbol.slice(0, -4)),
  );
  for (const asset of assets) {
    const spotQuantity = spots.find((s) => s.asset === asset)?.quantity ?? "0";
    const longQuantity = futures.positions
      .filter((p) => p.symbol === `${asset}USDT` && D(p.positionAmt).gt(0))
      .reduce((v, p) => v.plus(p.positionAmt), D(0));
    if (D(spotQuantity).plus(longQuantity).lte(0)) assets.delete(asset);
  }
  const result: Record<string, HedgePeriod> = {};
  const spotTrades = Object.values(ledger.markets).flatMap((m) => m.trades);
  for (const asset of Object.keys(anchors)) {
    if (!assets.has(asset)) delete anchors[asset];
  }
  for (const asset of assets) {
    const s = spots.find((h) => h.asset === asset) ?? { quantity: "0", value: "0" };
    if (s.value === null || STABLECOINS.has(asset)) continue;
    const ps = futures.positions.filter((p) => p.symbol === `${asset}USDT`);
    const floating = ps.reduce((v, p) => v.plus(p.unRealizedProfit), D(0));
    const relevant = Object.values(ledger.markets).filter((m) => m.baseAsset === asset);
    const anchor = anchors[asset];
    if (!anchor) {
      // Wait until history is complete so backfilled pre-baseline trades cannot
      // be mistaken for new activity. Retain existing anchors during outages.
      if (!data.tradesComplete || !futures.complete) continue;
      anchors[asset] = {
        startedAt: now,
        spotQuantity: s.quantity,
        spotValue: s.value,
        futuresFloating: floating.toString(),
        spotTradeIds: spotTrades.filter((t) => t.time >= now - 60000).map(tradeId),
        incomeIds: futures.ledger.incomes.filter((i) => i.time >= now - 60000).map(incomeId),
      };
    }
    const a = anchors[asset];
    let valid = data.tradesComplete && futures.complete;
    let note = valid ? "" : "成交或资金流水待同步";
    let expected = D(a.spotQuantity),
      cash = D(0),
      spotFees = D(0),
      baseFees = D(0);
    const seen = new Set(a.spotTradeIds);
    for (const m of relevant)
      for (const t of m.trades) {
        const key = tradeId(t);
        if (t.time <= a.startedAt || seen.has(key)) continue;
        seen.add(key);
        if (m.quoteAsset !== "USDT") {
          valid = false;
          note = "跨币成交待核算";
          continue;
        }
        expected = expected.plus(D(t.quantity).mul(t.side === "BUY" ? 1 : -1));
        cash = cash.plus(D(t.quoteQuantity).mul(t.side === "SELL" ? 1 : -1));
        const fee = D(t.fee);
        if (fee.isZero()) continue;
        const rate =
          t.feeAsset === "USDT"
            ? "1"
            : t.feeAsset === asset
              ? D(t.quoteQuantity).div(t.quantity).toString()
              : ledger.feeRates?.[minute(t.feeAsset, t.time)]?.price;
        if (!rate) {
          valid = false;
          note = "手续费汇率待同步";
          continue;
        }
        spotFees = spotFees.minus(fee.mul(rate));
        if (t.feeAsset === asset) {
          expected = expected.minus(fee);
          baseFees = baseFees.plus(fee.mul(rate));
        }
      }
    // Base assets spent on fees of other markets affect inventory too; this is
    // not a return of this hedge. Mark it unknown instead of hiding cash flows.
    if (expected.minus(s.quantity).abs().gt("0.000000000001")) {
      valid = false;
      note = "持仓含转入、转出或其他非成交变动，期间损益待核对";
    }
    let realized = D(0),
      funding = D(0),
      fees = spotFees;
    const seenIncome = new Set(a.incomeIds);
    for (const i of futures.ledger.incomes) {
      const key = incomeId(i);
      if (i.symbol !== `${asset}USDT` || i.time <= a.startedAt || seenIncome.has(key)) continue;
      seenIncome.add(key);
      if (!["REALIZED_PNL", "COMMISSION", "FUNDING_FEE"].includes(i.incomeType)) continue;
      const rate = i.asset === "USDT" ? "1" : futures.ledger.feeRates[minute(i.asset, i.time)];
      if (!rate && !D(i.income).isZero()) {
        valid = false;
        note = "合约流水汇率待同步";
        continue;
      }
      const amount = D(i.income).mul(rate ?? 0);
      if (i.incomeType === "REALIZED_PNL") realized = realized.plus(amount);
      if (i.incomeType === "COMMISSION") fees = fees.plus(amount);
      if (i.incomeType === "FUNDING_FEE") funding = funding.plus(amount);
    }
    const spotPnl = D(s.value).minus(a.spotValue).plus(cash).plus(baseFees);
    const futuresPnl = floating.minus(a.futuresFloating).plus(realized);
    result[asset] = {
      startedAt: a.startedAt,
      spotPnl: valid ? spotPnl.toString() : null,
      futuresPnl: valid ? futuresPnl.toString() : null,
      fundingPnl: valid ? funding.toString() : null,
      feePnl: valid ? fees.toString() : null,
      netPnl: valid ? spotPnl.plus(futuresPnl).plus(funding).plus(fees).toString() : null,
      complete: valid,
      note,
    };
  }
  return result;
}
