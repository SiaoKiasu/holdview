import Decimal from "decimal.js";
import type { ProviderData } from "./types";
import { feeRateKey, tradeRealizedPnl } from "./trade-pnl";
import { incomeIdentity } from "./futures-units";
const D = (v: Decimal.Value) => new Decimal(v);
Decimal.set({ precision: 36 });
export type CoinInventory = {
  quantity: string;
  averageCost: string | null;
  cost: string | null;
  realizedCoin: string;
  fundingCoin: string;
  commissionCoin: string;
  rebateCoin: string;
  realizedValue: string | null;
  fundingValue: string | null;
  commissionValue: string | null;
  rebateValue: string | null;
  disposalPnl: string | null;
  complete: boolean;
  issues: string[];
};

// One moving-average inventory per asset across spot and CM wallets. Transfers
// change location, never basis. Only settled income creates owned coin inventory.
export function coinInventory(data: ProviderData) {
  const ledger = data.ledger,
    cm = ledger?.coinFutures;
  const managed = new Set([
    ...(data.futures?.coinWallets ?? []).map((w) => w.asset),
    ...(cm?.incomes ?? []).map((i) => i.asset),
    ...(cm?.transfers?.rows ?? []).map((t) => t.asset),
  ]);
  managed.delete("USDT");
  const legacy = tradeRealizedPnl(ledger, data.tradesComplete);
  const assets: Record<string, CoinInventory> = {};
  if (!managed.size) return { assets, accounting: legacy };
  type Pool = { qty: Decimal; cost: Decimal; issues: Set<string>; fx: Decimal };
  const pools = new Map<string, Pool>();
  const pool = (a: string) => {
    if (!pools.has(a)) pools.set(a, { qty: D(0), cost: D(0), issues: new Set(), fx: D(0) });
    return pools.get(a)!;
  };
  const missingBuys = new Set<string>(),
    missingRates = new Set<string>();
  let realized = D(0),
    fees = D(0),
    unsupported = false,
    estimatedFees = false;
  function remove(a: string, qty: Decimal, proceeds: Decimal, realize: boolean) {
    const p = pool(a);
    if (realize && p.issues.has("历史取得数量不足")) missingBuys.add(a);
    if (p.qty.lt(qty) || p.qty.lte(0)) {
      p.issues.add("历史取得数量不足");
      missingBuys.add(a);
      p.qty = p.qty.minus(qty);
      return;
    }
    const basis = p.cost.mul(qty).div(p.qty);
    p.qty = p.qty.minus(qty);
    p.cost = p.qty.isZero() ? D(0) : p.cost.minus(basis);
    if (realize) {
      const gain = proceeds.minus(basis);
      realized = realized.plus(gain);
      return gain;
    }
  }
  const events = Object.values(ledger?.markets ?? {}).flatMap((m) =>
    [...new Map(m.trades.map((t) => [t.id, t])).values()].map((t) => ({ time: t.time, m, t })),
  );
  const incomes = [...new Map((cm?.incomes ?? []).map((i) => [incomeIdentity(i), i])).values()];
  const settlements: Record<
    string,
    {
      realized: Decimal;
      funding: Decimal;
      commission: Decimal;
      rebate: Decimal;
      rv: Decimal;
      fv: Decimal;
      cv: Decimal;
      rbv: Decimal;
      rates: boolean;
    }
  > = {};
  const totals = (a: string) =>
    (settlements[a] ??= {
      realized: D(0),
      funding: D(0),
      commission: D(0),
      rebate: D(0),
      rv: D(0),
      fv: D(0),
      cv: D(0),
      rbv: D(0),
      rates: true,
    });
  const timeline = [
    ...events.map((e) => ({
      time: e.time,
      key: `0:${e.t.symbol}:${e.t.id.padStart(24, "0")}`,
      event: e,
      income: undefined,
    })),
    ...incomes.map((i) => ({
      time: i.time,
      key: `1:${incomeIdentity(i)}`,
      event: undefined,
      income: i,
    })),
  ].sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
  for (const row of timeline) {
    if (row.income) {
      const i = row.income;
      if (!managed.has(i.asset) || D(i.income).isZero() || i.incomeType === "TRANSFER") continue;
      const p = pool(i.asset),
        qty = D(i.income),
        s = totals(i.asset);
      const category =
        i.incomeType === "REALIZED_PNL"
          ? "realized"
          : i.incomeType === "FUNDING_FEE"
            ? "funding"
            : i.incomeType === "COMMISSION"
              ? "commission"
              : i.incomeType === "COMMISSION_REBATE"
                ? "rebate"
                : null;
      if (!category) {
        p.issues.add(`未核对流水 ${i.incomeType}`);
        continue;
      }
      s[category] = s[category].plus(qty);
      const rate = cm?.feeRates[feeRateKey(i.asset, i.time)];
      if (!rate || !D(rate).gt(0)) {
        p.issues.add("结算历史汇率待补齐");
        s.rates = false;
        continue;
      }
      const value = qty.mul(rate);
      const valueKey =
        category === "realized"
          ? "rv"
          : category === "funding"
            ? "fv"
            : category === "rebate"
              ? "rbv"
              : "cv";
      s[valueKey] = s[valueKey].plus(value);
      if (qty.gt(0)) {
        p.qty = p.qty.plus(qty);
        p.cost = p.cost.plus(value);
      } else {
        const fx = remove(i.asset, qty.negated(), value.negated(), true);
        if (fx) p.fx = p.fx.plus(fx);
      }
      // Income itself is counted by futuresAccounting. Only coin disposal FX is new here.
      continue;
    }
    const { m, t } = row.event!;
    if (m.quoteAsset !== "USDT") {
      unsupported = true;
      pool(m.baseAsset).issues.add("跨币成交待核对");
      pool(m.quoteAsset).issues.add("跨币成交待核对");
      continue;
    }
    const p = pool(m.baseAsset),
      qty = D(t.quantity),
      quote = D(t.quoteQuantity),
      fee = D(t.fee);
    const baseFee = t.feeAsset === m.baseAsset ? fee : D(0);
    let feeValue = D(0);
    if (fee.gt(0)) {
      const rate =
        t.feeAsset === m.baseAsset
          ? qty.gt(0)
            ? quote.div(qty).toString()
            : undefined
          : t.feeAsset === "USDT"
            ? "1"
            : ledger?.feeRates?.[feeRateKey(t.feeAsset, t.time)]?.price;
      if (!rate || !D(rate).gt(0)) {
        missingRates.add(t.feeAsset);
        p.issues.add("成交手续费汇率待补齐");
      } else feeValue = fee.mul(rate);
      if (t.feeAsset !== m.baseAsset && t.feeAsset !== "USDT") estimatedFees = true;
    }
    fees = fees.plus(feeValue);
    if (managed.has(m.baseAsset)) {
      realized = realized.minus(feeValue);
      if (t.side === "BUY") {
        p.qty = p.qty.plus(qty);
        p.cost = p.cost.plus(quote);
      } else remove(m.baseAsset, qty, quote, true);
      if (baseFee.gt(0)) {
        const fx = remove(m.baseAsset, baseFee, feeValue, true);
        if (fx) p.fx = p.fx.plus(fx);
      }
    } else {
      // Preserve the existing fee-exclusive spot basis for unaffected assets.
      const baseFeeValue = baseFee.gt(0) ? baseFee.mul(quote).div(qty) : D(0);
      realized = realized.minus(t.side === "SELL" ? feeValue.minus(baseFeeValue) : feeValue);
      if (t.side === "BUY") {
        p.qty = p.qty.plus(qty.minus(baseFee));
        p.cost = p.cost.plus(quote.minus(baseFeeValue));
      } else remove(m.baseAsset, qty.plus(baseFee), quote, true);
    }
    if (fee.gt(0) && t.feeAsset !== m.baseAsset && t.feeAsset !== "USDT") {
      const fp = pool(t.feeAsset);
      if (managed.has(t.feeAsset)) {
        const fx = remove(t.feeAsset, fee, feeValue, true);
        if (fx) fp.fx = fp.fx.plus(fx);
      } else if (fp.qty.gte(fee)) remove(t.feeAsset, fee, D(0), false);
      else {
        fp.issues.add("历史取得数量不足");
        fp.qty = D(0);
        fp.cost = D(0);
      }
    }
  }
  for (const a of managed) {
    const p = pool(a),
      s = totals(a);
    const wallet = data.futures?.coinWallets?.find((w) => w.asset === a);
    const spot = data.balances.find((b) => b.asset === a);
    const actual = D(spot?.free ?? 0)
      .plus(spot?.locked ?? 0)
      .plus(wallet?.walletBalance ?? 0);
    // Binance account quantities are reported to 8 decimal places. Never use a $1
    // dust threshold for accounting reconciliation; tiny coins can carry material value.
    const close = (x: Decimal, y: Decimal) => x.minus(y).abs().lte("0.00000001");
    if (
      Object.values(ledger?.markets ?? {}).some(
        (m) => (m.baseAsset === a || m.quoteAsset === a) && !m.complete,
      )
    )
      p.issues.add("相关成交分页待补齐");
    if (!close(actual, p.qty)) p.issues.add("持币数量与成交、结算流水不一致");
    const transfers = cm?.transfers;
    const moved = (transfers?.rows ?? [])
      .filter((t) => t.asset === a && t.status === "CONFIRMED")
      .reduce((n, t) => n.plus(D(t.amount).mul(t.type === "MAIN_CMFUTURE" ? 1 : -1)), D(0));
    const allIncome = incomes
      .filter((i) => i.asset === a && i.incomeType !== "TRANSFER")
      .reduce((n, i) => n.plus(i.income), D(0));
    if (!transfers?.complete || !close(moved.plus(allIncome), D(wallet?.walletBalance ?? 0)))
      p.issues.add("保证金划转与钱包余额待核对");
    if (
      !data.tradesComplete ||
      !data.futures?.complete ||
      cm?.historyGap ||
      cm?.incomeWindows?.length
    )
      p.issues.add("历史流水待补齐");
    const complete = !p.issues.size;
    assets[a] = {
      quantity: actual.toString(),
      averageCost: complete && p.qty.gt(0) ? p.cost.div(p.qty).toString() : null,
      cost: complete ? p.cost.toString() : null,
      complete,
      issues: [...p.issues],
      realizedCoin: s.realized.toString(),
      fundingCoin: s.funding.toString(),
      commissionCoin: s.commission.toString(),
      rebateCoin: s.rebate.toString(),
      realizedValue: s.rates ? s.rv.toString() : null,
      fundingValue: s.rates ? s.fv.toString() : null,
      commissionValue: s.rates ? s.cv.toString() : null,
      rebateValue: s.rates ? s.rbv.toString() : null,
      disposalPnl: complete ? p.fx.toString() : null,
    };
  }
  const known =
    !unsupported &&
    !missingBuys.size &&
    !missingRates.size &&
    Object.values(assets).every((a) => a.complete);
  return {
    assets,
    accounting: {
      ...legacy,
      realizedPnl: known ? realized.toString() : null,
      feePnl: !missingRates.size && !unsupported ? fees.negated().toString() : null,
      complete: known && data.tradesComplete,
      missingBuys: [...missingBuys],
      missingRates: [...missingRates],
      unsupported,
      estimatedFees,
    },
  };
}
