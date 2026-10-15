import Decimal from "decimal.js";
import type { Dashboard, Order } from "./types";
import { STABLECOINS } from "./assets";

const D = Decimal.clone({ precision: 36 });
export type PlanOrder = Order & { manual?: boolean };
export type PlanChoice = { enabled: boolean; percent: string; price?: string };
export const planKey = (o: Order) => `${o.instrument ?? "spot"}:${o.symbol}:${o.id}`;
const number = (v: string | undefined | null) =>
  v !== undefined && v !== null && /^\d+(\.\d+)?$/.test(v) ? new D(v) : null;
export const orderAsset = (o: Order) =>
  o.baseAsset ?? (o.symbol.endsWith("USDT") ? o.symbol.slice(0, -4) : o.symbol);
export const remaining = (o: Order) =>
  D.max(0, new D(o.quantity).minus(o.executedQuantity)).toString();
export function projectPlan(
  data: Dashboard,
  orders: PlanOrder[],
  choices: Record<string, PlanChoice>,
  feePercent = "0",
) {
  const equity = new D(data.summary.equity);
  const ratio = (n: Decimal | null) =>
    n !== null && equity.gt(0) && data.summary.equityComplete
      ? n.div(equity).mul(100).toString()
      : null;
  const feeInput = number(feePercent);
  const errors: string[] = [];
  if (!feeInput || feeInput.gt(10)) errors.push("手续费率须在 0% 至 10% 之间");
  const fee = (feeInput ?? new D(0)).div(100);
  type Position = {
    key: string;
    asset: string;
    futures: boolean;
    short: boolean;
    currentQuantity: Decimal;
    quantity: Decimal;
    currentCost: Decimal | null;
    cost: Decimal | null;
    mark: Decimal | null;
    buy: Decimal;
    sell: Decimal;
  };
  const positions = new Map<string, Position>();
  for (const h of data.holdings) {
    if (STABLECOINS.has(h.asset) && !h.instrument) continue;
    const key = `${h.instrument ?? "spot"}:${h.symbol ?? h.asset}:${h.direction === "空" ? "short" : "long"}`;
    const q = new D(h.quantity).abs();
    const avg = number(h.averageCost);
    positions.set(key, {
      key,
      asset: h.asset,
      futures: !!h.instrument,
      short: h.direction === "空",
      currentQuantity: q,
      quantity: q,
      currentCost: avg === null ? null : q.mul(avg),
      cost: avg === null ? null : q.mul(avg),
      mark: number(h.price),
      buy: new D(0),
      sell: new D(0),
    });
  }
  let buy = new D(0),
    sell = new D(0),
    fees = new D(0),
    spotBuy = new D(0),
    spotSell = new D(0),
    released = new D(0),
    selectedPnl: Decimal | null = new D(0);
  const groups = new Set<string>();
  const rows = orders.map((o) => {
    const key = planKey(o),
      choice = choices[key] ?? { enabled: false, percent: "100" };
    const price = number(choice.price ?? o.price),
      percent = number(choice.percent);
    const qty = new D(remaining(o));
    const selected = choice.enabled;
    const quote = o.quoteAsset ?? (o.symbol.endsWith("USDT") ? "USDT" : "");
    const supported = quote === "USDT" && !o.closePosition && o.positionSide !== "SHORT";
    let error = "";
    if (selected && !supported) error = "仅测算 USDT 现货 / 多头固定数量订单";
    else if (selected && o.instrument && data.connection.futuresPositionsComplete === false)
      error = "合约持仓未完整读取";
    else if (
      selected &&
      o.instrument &&
      o.positionSide !== "LONG" &&
      data.holdings.some((h) => h.instrument && h.symbol === o.symbol && h.direction === "空")
    )
      error = "单向空仓不能按多头加仓测算";
    else if (selected && (!price || price.lte(0))) error = "填写预期成交价";
    else if (selected && (!percent || percent.gt(100))) error = "成交比例须为 0–100%";
    if (selected && o.orderListId) {
      const group = `${o.instrument ?? "spot"}:${o.orderListId}`;
      if (groups.has(group)) error = "同一关联订单只能选择一个分支";
      groups.add(group);
    }
    if (error) errors.push(`${o.symbol}：${error}`);
    const fill = selected && !error ? qty.mul(percent!).div(100) : new D(0);
    return {
      order: o,
      key,
      choice,
      remaining: qty.toString(),
      fill: fill.toString(),
      price: price?.toString() ?? null,
      amount: price ? fill.mul(price).toString() : null,
      remainingAmount: price ? qty.mul(price).toString() : null,
      remainingAllocation: price && quote === "USDT" ? ratio(qty.mul(price)) : null,
      selectedAllocation: price && quote === "USDT" ? ratio(fill.mul(price)) : null,
      filledAllocation:
        quote === "USDT"
          ? o.executedQuote !== undefined
            ? ratio(new D(o.executedQuote))
            : new D(o.executedQuantity).isZero()
              ? "0"
              : null
          : null,
      error,
      supported,
    };
  });
  // One explicit scenario: all selected buys fill, then selected sells.
  for (const row of [...rows].sort(
    (a, b) => (a.order.side === "BUY" ? 0 : 1) - (b.order.side === "BUY" ? 0 : 1),
  )) {
    if (row.error || new D(row.fill).isZero()) continue;
    const o = row.order,
      asset = orderAsset(o),
      futures = !!o.instrument,
      qty = new D(row.fill),
      price = new D(row.price!);
    let p = [...positions.values()].find(
      (p) =>
        p.asset === asset &&
        p.futures === futures &&
        !p.short &&
        (!futures || p.key.includes(o.symbol)),
    );
    if (!p) {
      const key = `${o.instrument ?? "spot"}:${futures ? o.symbol : asset}:long`;
      p = {
        key,
        asset,
        futures,
        short: false,
        currentQuantity: new D(0),
        quantity: new D(0),
        currentCost: new D(0),
        cost: new D(0),
        mark: null,
        buy: new D(0),
        sell: new D(0),
      };
      positions.set(key, p);
    }
    const amount = qty.mul(price),
      commission = amount.mul(fee);
    if (futures && o.reduceOnly && o.side === "BUY") {
      errors.push(`${o.symbol}：减仓买单不能按多头加仓测算`);
      continue;
    }
    if (o.side === "SELL" && qty.gt(p.quantity)) {
      errors.push(`${o.symbol}：卖出数量超过测算持仓`);
      continue;
    }
    fees = fees.plus(commission);
    if (o.side === "BUY") {
      p.quantity = p.quantity.plus(qty);
      p.cost = p.cost?.plus(amount) ?? null;
      p.buy = p.buy.plus(amount);
      buy = buy.plus(amount);
      if (!futures) {
        spotBuy = spotBuy.plus(amount).plus(commission);
        if (!o.manual) released = released.plus(qty.mul(o.price));
      }
      selectedPnl = selectedPnl?.minus(commission) ?? null;
    } else {
      const basis = p.cost !== null && p.quantity.gt(0) ? p.cost.div(p.quantity).mul(qty) : null;
      p.quantity = p.quantity.minus(qty);
      p.cost = p.quantity.isZero()
        ? new D(0)
        : p.cost !== null && basis !== null
          ? p.cost.minus(basis)
          : null;
      p.sell = p.sell.plus(amount);
      sell = sell.plus(amount);
      if (!futures) spotSell = spotSell.plus(amount).minus(commission);
      selectedPnl =
        selectedPnl !== null && basis !== null
          ? selectedPnl.plus(amount).minus(basis).minus(commission)
          : null;
    }
  }
  const result = [...positions.values()].map((p) => ({
    key: p.key,
    asset: p.asset,
    futures: p.futures,
    currentQuantity: p.currentQuantity.toString(),
    quantity: p.quantity.toString(),
    currentAverage:
      p.currentCost !== null && p.currentQuantity.gt(0)
        ? p.currentCost.div(p.currentQuantity).toString()
        : null,
    average: p.cost !== null && p.quantity.gt(0) ? p.cost.div(p.quantity).toString() : null,
    currentAllocation: ratio(p.currentCost),
    allocation: ratio(p.cost),
    valueAllocation: p.mark ? ratio(p.currentQuantity.mul(p.mark)) : null,
    buy: p.buy.toString(),
    sell: p.sell.toString(),
    cost: p.cost?.toString() ?? null,
  }));
  const total = (field: "currentCost" | "cost") =>
    [...positions.values()].every((p) => p[field] !== null)
      ? [...positions.values()].reduce((sum, p) => sum.plus(p[field]!), new D(0))
      : null;
  const cash = new D(data.summary.cash).minus(spotBuy).plus(spotSell);
  const locked = D.max(0, new D(data.summary.cashLocked).minus(released));
  const free = data.connection.ordersComplete ? cash.minus(locked) : null;
  const notices: string[] = [];
  for (const h of data.holdings.filter((h) => !h.instrument)) {
    const matching = rows.filter(
      (r) => !r.order.instrument && orderAsset(r.order) === h.asset && r.order.side === "SELL",
    );
    const unlocked = matching
      .filter((r) => !r.order.manual)
      .reduce((n, r) => n.plus(r.fill), new D(0));
    const reserved = D.max(0, new D(h.locked).minus(unlocked));
    const projected = result.find((p) => p.asset === h.asset && !p.futures);
    if (projected && reserved.gt(projected.quantity))
      notices.push(h.asset + "：手动卖出占用了未选卖单冻结的数量，需先调整交易所挂单");
  }
  if (!data.connection.ordersComplete) notices.push("挂单尚未完整读取，可用资金测算暂缺");
  if (!data.summary.equityComplete) notices.push("账户权益未完整读取，资金占比暂缺");
  if (spotBuy.gt(data.summary.cash)) notices.push("现货买入预算不足，需先卖出或补充现金");
  if (free?.lt(0)) notices.push("预计可用现金不足；未选挂单仍占用冻结资金");
  if (rows.some((r) => r.choice.enabled && r.order.instrument))
    notices.push("合约按 1× 名义投入展示，实际保证金以交易所为准");
  return {
    rows,
    positions: result,
    valid: errors.length === 0,
    errors,
    notices,
    buy: buy.toString(),
    sell: sell.toString(),
    fees: fees.toString(),
    selectedPnl: selectedPnl?.toString() ?? null,
    cost: total("cost")?.toString() ?? null,
    currentCost: total("currentCost")?.toString() ?? null,
    allocation: ratio(total("cost")),
    currentAllocation: ratio(total("currentCost")),
    cash: cash.toString(),
    free: free?.toString() ?? null,
    locked: locked.toString(),
  };
}
