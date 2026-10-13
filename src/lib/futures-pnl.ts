import Decimal from "decimal.js";
import type { FuturesData, Holding } from "./types";
import { incomeRateKey } from "./binance-futures";
Decimal.set({ precision: 36 });

// Exchange income amounts already carry their sign. Transfers are deliberately excluded.
export function futuresAccounting(data: FuturesData | undefined) {
  if (!data)
    return {
      holdings: [] as Holding[],
      realizedPnl: null,
      feePnl: null,
      holdingPnl: null,
      fundingPnl: null,
      complete: false,
      warnings: [] as string[],
    };
  let realized = new Decimal(0),
    fees = new Decimal(0),
    funding = new Decimal(0);
  let realizedKnown = true,
    fundingKnown = true;
  const fundingBySymbol = new Map<string, Decimal>();
  const unknownFunding = new Set<string>();
  const missingRates = new Set<string>();
  const seen = new Set<string>();
  for (const i of data.ledger.incomes) {
    if (!["REALIZED_PNL", "COMMISSION", "FUNDING_FEE"].includes(i.incomeType)) continue;
    const key = `${i.incomeType}:${i.tranId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rate = i.asset === "USDT" ? "1" : data.ledger.feeRates[incomeRateKey(i)];
    if (!rate && !new Decimal(i.income).isZero()) {
      missingRates.add(i.asset);
      if (i.incomeType === "FUNDING_FEE") {
        fundingKnown = false;
        unknownFunding.add(i.symbol);
      } else realizedKnown = false;
      continue;
    }
    const amount = new Decimal(i.income).mul(rate ?? 0);
    if (i.incomeType === "FUNDING_FEE") {
      funding = funding.plus(amount);
      fundingBySymbol.set(i.symbol, (fundingBySymbol.get(i.symbol) ?? new Decimal(0)).plus(amount));
    } else {
      realized = realized.plus(amount);
      if (i.incomeType === "COMMISSION") fees = fees.plus(amount);
    }
  }
  const symbols = new Set([
    ...data.positions.map((p) => p.symbol),
    ...fundingBySymbol.keys(),
    ...unknownFunding,
  ]);
  const unsupported = data.positions.some(
    (p) => p.marginAsset !== "USDT" || !p.symbol.endsWith("USDT"),
  );
  // An unsuccessful initial history read must not look like a confirmed zero.
  const hasIncome = data.complete || data.ledger.incomes.length > 0;
  // Trade details provide a provisional realized subtotal if income history is unavailable.
  let hasRealized = hasIncome;
  if (!hasIncome && data.trades?.length) {
    hasRealized = true;
    for (const t of data.trades) {
      const rate =
        t.feeAsset === "USDT"
          ? "1"
          : data.ledger.feeRates[`${t.feeAsset}:${Math.floor(t.time / 60000) * 60000}`];
      if (!t.symbol.endsWith("USDT") || (Number(t.fee) !== 0 && !rate)) {
        realizedKnown = false;
        continue;
      }
      const charge = new Decimal(t.fee).mul(rate ?? 0);
      fees = fees.minus(charge);
      realized = realized.plus(t.realizedPnl ?? 0).minus(charge);
    }
  }
  const holdings: Holding[] = [...symbols].filter(Boolean).flatMap((symbol) => {
    const ps = data.positions.filter((p) => p.symbol === symbol);
    const fundingAmount = fundingBySymbol.get(symbol) ?? new Decimal(0);
    if (!ps.length && fundingAmount.isZero() && !unknownFunding.has(symbol)) return [];
    const valid = ps.every(
      (p) =>
        p.marginAsset === "USDT" && p.symbol.endsWith("USDT") && new Decimal(p.markPrice).gt(0),
    );
    const quantity = ps.reduce((a, p) => a.plus(new Decimal(p.positionAmt).abs()), new Decimal(0));
    const basis = ps.reduce(
      (a, p) => a.plus(new Decimal(p.positionAmt).abs().mul(p.entryPrice)),
      new Decimal(0),
    );
    const notional = ps.reduce(
      (a, p) => a.plus(new Decimal(p.positionAmt).abs().mul(p.markPrice)),
      new Decimal(0),
    );
    const pricePnl = ps.reduce((a, p) => a.plus(p.unRealizedProfit), new Decimal(0));
    const pnl = valid ? pricePnl.plus(fundingAmount) : null;
    const long = ps.some((p) => new Decimal(p.positionAmt).gt(0));
    const short = ps.some((p) => new Decimal(p.positionAmt).lt(0));
    return [
      {
        instrument: "futures" as const,
        symbol,
        asset: symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol,
        direction: !ps.length
          ? ("已平仓" as const)
          : long && short
            ? ("双向" as const)
            : short
              ? ("空" as const)
              : ("多" as const),
        free: quantity.toString(),
        locked: "0",
        quantity: quantity.toString(),
        price: valid && quantity.gt(0) ? notional.div(quantity).toString() : null,
        averageCost: quantity.gt(0) ? basis.div(quantity).toString() : null,
        value: valid ? notional.toString() : null,
        allocation: 0,
        change24h: null,
        unrealizedPnl: pnl?.toString() ?? null,
        pnlComplete: data.complete && !unknownFunding.has(symbol),
        fundingPnl: hasIncome && !unknownFunding.has(symbol) ? fundingAmount.toString() : null,
        returnRate: pnl !== null && basis.gt(0) ? pnl.div(basis).mul(100).toString() : null,
      },
    ];
  });
  const positionPnl = data.positions.reduce((a, p) => a.plus(p.unRealizedProfit), new Decimal(0));
  const warnings: string[] = [];
  if (missingRates.size)
    warnings.push(`合约盈亏等待手续费或资金费历史汇率：${[...missingRates].join("、")}。`);
  if (unsupported) warnings.push("存在非 USDT 保证金合约，该部分盈亏尚不支持按 USDT 汇总。");
  return {
    holdings,
    realizedPnl: hasRealized && realizedKnown && !unsupported ? realized.toString() : null,
    feePnl: hasRealized && realizedKnown ? fees.toString() : null,
    holdingPnl:
      data.positionsComplete !== false && !unsupported
        ? positionPnl.plus(funding).toString()
        : null,
    fundingPnl: hasIncome && fundingKnown ? funding.toString() : null,
    complete:
      data.complete &&
      data.positionsComplete !== false &&
      realizedKnown &&
      fundingKnown &&
      !unsupported,
    warnings,
  };
}
