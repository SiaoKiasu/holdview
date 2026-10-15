"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Dashboard } from "@/lib/types";
import { formatPrice } from "@/lib/price-format";
import { projectPlan, planKey, type PlanChoice, type PlanOrder } from "@/lib/trade-plan";

export function TradePlanPanel({ data, hidden }: { data: Dashboard; hidden: boolean }) {
  const [choices, setChoices] = useState<Record<string, PlanChoice>>({});
  const [manual, setManual] = useState<PlanOrder[]>([]);
  const [fee, setFee] = useState("0");
  const [draft, setDraft] = useState({
    asset: "",
    market: "spot",
    side: "BUY",
    price: "",
    quantity: "",
  });
  const [inputError, setInputError] = useState("");
  const orders = [...data.orders, ...manual];
  const plan = projectPlan(data, orders, choices, fee);
  const num = (n: string | null, digits = 2) =>
    hidden
      ? "••••"
      : n === null
        ? "—"
        : Number(n).toLocaleString("en-US", {
            maximumFractionDigits: digits,
            minimumFractionDigits: digits === 2 ? 2 : 0,
          });
  const price = (n: string | null) => (hidden ? "••••" : formatPrice(n));
  const pct = (n: string | null) => (n === null || hidden ? num(n) : num(n) + "%");
  const after = (n: string | null) => (plan.valid ? n : null);
  const change = (key: string, value: Partial<PlanChoice>) =>
    setChoices((c) => ({
      ...c,
      [key]: { ...(c[key] ?? { enabled: false, percent: "100" }), ...value },
    }));
  const select = (enabled: boolean) =>
    setChoices((c) =>
      Object.fromEntries(
        plan.rows.map((r) => [
          r.key,
          {
            ...c[r.key],
            percent: c[r.key]?.percent ?? "100",
            enabled: enabled && r.supported && !r.order.orderListId && Number(r.price) > 0,
          },
        ]),
      ),
    );
  function add() {
    const asset = draft.asset.trim().toUpperCase().replace(/USDT$/, "");
    if (
      !/^[\p{L}\p{N}]{1,30}$/u.test(asset) ||
      !/^\d+(\.\d+)?$/.test(draft.price) ||
      Number(draft.price) <= 0 ||
      !/^\d+(\.\d+)?$/.test(draft.quantity) ||
      Number(draft.quantity) <= 0
    ) {
      setInputError("填写币种、正数价格和数量");
      return;
    }
    const order: PlanOrder = {
      id: crypto.randomUUID(),
      manual: true,
      instrument: draft.market === "futures" ? "futures" : undefined,
      symbol: asset + "USDT",
      baseAsset: asset,
      quoteAsset: "USDT",
      side: draft.side as "BUY" | "SELL",
      type: "LIMIT",
      price: draft.price,
      quantity: draft.quantity,
      executedQuantity: "0",
      executedQuote: "0",
      status: "SIMULATION",
      time: Date.now(),
    };
    setManual((v) => [...v, order]);
    change(planKey(order), { enabled: true });
    setInputError("");
    setDraft((v) => ({ ...v, price: "", quantity: "" }));
  }
  return (
    <div className="review-page trade-plan">
      <div className="review-stats">
        <section className="stat">
          <div className="stat-label">预计买入 / 卖出 · USDT</div>
          <div className="plan-stat-pair">
            {num(after(plan.buy))}
            <span>/ {num(after(plan.sell))}</span>
          </div>
          <small className="muted-text">预计交易费 {num(after(plan.fees))}</small>
        </section>
        <section className="stat">
          <div className="stat-label">持仓投入占比 · 当前 → 成交后</div>
          <div className="plan-stat-pair">
            {pct(plan.currentAllocation)}
            <span>→ {pct(after(plan.allocation))}</span>
          </div>
          <small className="muted-text">成本投入 / 当前 Equity</small>
        </section>
        <section className="stat">
          <div className="stat-label">现货现金 · 成交后</div>
          <div className="stat-value">
            {num(after(plan.cash))}
            <small>USDT</small>
          </div>
          <small className="muted-text">
            可用 {num(after(plan.free))} · 冻结 {num(after(plan.locked))}
          </small>
        </section>
        <section className="stat">
          <div className="stat-label">选定交易净收益 · 测算</div>
          <div className="stat-value">
            {num(after(plan.selectedPnl))}
            <small>USDT</small>
          </div>
          <small className="muted-text">平仓价差减本次买卖费用</small>
        </section>
      </div>
      {plan.errors.length > 0 && (
        <div className="plan-alert" role="alert">
          {plan.errors.join("；")}
        </div>
      )}
      {plan.notices.map((n) => (
        <div className="plan-notice" key={n}>
          {n}
        </div>
      ))}
      <section className="panel">
        <div className="panel-heading">
          <h2>
            挂单选择 <span className="count">{data.orders.length}</span>
          </h2>
          <div className="plan-actions">
            <button onClick={() => select(true)}>全选可测算单</button>
            <button onClick={() => select(false)}>清空选择</button>
            <label>
              费用率 %{" "}
              <input
                aria-label="测算手续费率"
                inputMode="decimal"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="table-scroll">
          <table className="plan-table">
            <thead>
              <tr>
                {[
                  "计入",
                  "交易对 / 来源",
                  "方向 / 类型",
                  "委托价 / 触发价",
                  "委托数量",
                  "已成交数量",
                  "待成交数量",
                  "已成交占比¹",
                  "待成交占比¹",
                  "预计成交 %²",
                  "预期成交价",
                  "预计金额 / 占比¹",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <input
                      aria-label={`计入 ${r.order.symbol} ${r.order.id}`}
                      type="checkbox"
                      checked={r.choice.enabled}
                      onChange={(e) => change(r.key, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>
                    <strong>{r.order.symbol}</strong>
                    <small>
                      {r.order.manual ? "手动测算" : r.order.instrument ? "合约挂单" : "现货挂单"}
                      {r.order.orderListId ? " · 关联单" : ""}
                    </small>
                    {r.order.manual && (
                      <button
                        aria-label="删除测算单"
                        onClick={() => setManual((v) => v.filter((o) => planKey(o) !== r.key))}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                  <td>
                    <span className={r.order.side === "BUY" ? "positive" : "negative"}>
                      {r.order.side === "BUY" ? "买入" : "卖出"}
                    </span>
                    <small>{r.order.type}</small>
                  </td>
                  <td>
                    {price(r.order.price)}
                    <small>
                      {Number(r.order.stopPrice) > 0 ? "触发 " + price(r.order.stopPrice!) : ""}
                    </small>
                  </td>
                  <td>{num(r.order.quantity, 8)}</td>
                  <td>{num(r.order.executedQuantity, 8)}</td>
                  <td>{num(r.remaining, 8)}</td>
                  <td>{pct(r.filledAllocation)}</td>
                  <td>{pct(r.remainingAllocation)}</td>
                  <td>
                    <input
                      aria-label={`成交比例 ${r.order.symbol} ${r.order.id}`}
                      inputMode="decimal"
                      value={r.choice.percent}
                      onChange={(e) => change(r.key, { percent: e.target.value })}
                    />
                  </td>
                  <td>
                    {hidden ? (
                      "••••"
                    ) : (
                      <input
                        aria-label={`预期成交价 ${r.order.symbol} ${r.order.id}`}
                        inputMode="decimal"
                        value={r.choice.price ?? r.order.price}
                        onChange={(e) => change(r.key, { price: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    {num(r.amount)}
                    <small>{pct(r.selectedAllocation)}</small>
                    {r.error && <small className="negative">{r.error}</small>}
                  </td>
                </tr>
              ))}
              {!orders.length && (
                <tr>
                  <td colSpan={12}>暂无挂单，可添加手动测算单</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="plan-note">
          当前现货可用 {num(data.summary.cashFree)} USDT
          {data.connection.futuresEnabled
            ? ` · 合约可用 ${num(data.summary.futuresAvailable ?? null)} USDT`
            : ""}
          <br />¹ 金额 / 当前 Equity。² 仅对剩余待成交数量生效。测算按先买后卖，费用折算
          USDT；不会提交订单。
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>添加测算单</h2>
        </div>
        <form
          className="plan-form"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <label>
            币种
            <input
              aria-label="测算币种"
              placeholder="如 BTC"
              value={draft.asset}
              onChange={(e) => setDraft({ ...draft, asset: e.target.value })}
            />
          </label>
          <label>
            账户
            <select
              value={draft.market}
              onChange={(e) => setDraft({ ...draft, market: e.target.value })}
            >
              <option value="spot">现货</option>
              <option value="futures">合约 · 多头</option>
            </select>
          </label>
          <label>
            方向
            <select
              value={draft.side}
              onChange={(e) => setDraft({ ...draft, side: e.target.value })}
            >
              <option value="BUY">买入 / 加仓</option>
              <option value="SELL">卖出 / 减仓</option>
            </select>
          </label>
          <label>
            价格 · USDT
            <input
              aria-label="测算单价格"
              inputMode="decimal"
              value={draft.price}
              onChange={(e) => setDraft({ ...draft, price: e.target.value })}
            />
          </label>
          <label>
            数量
            <input
              aria-label="测算单数量"
              inputMode="decimal"
              value={draft.quantity}
              onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
            />
          </label>
          <button className="button primary" type="submit">
            <Plus size={16} />
            加入测算
          </button>
        </form>
        {inputError && (
          <div className="plan-alert" role="alert">
            {inputError}
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>成交后持仓</h2>
          <span className="muted-text">占比按成本投入 / 当前 Equity</span>
        </div>
        <div className="table-scroll">
          <table className="plan-table">
            <thead>
              <tr>
                {[
                  "资产",
                  "当前数量",
                  "当前均价",
                  "当前市值占比",
                  "当前投入占比",
                  "预计买入金额",
                  "预计卖出金额",
                  "成交后数量",
                  "成交后均价",
                  "成交后投入占比",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plan.positions.map((p) => (
                <tr key={p.key}>
                  <td>
                    <strong>{p.asset}</strong>
                    {plan.positions.filter((v) => v.asset === p.asset).length > 1 && (
                      <small>{p.futures ? "合约" : "现货"}</small>
                    )}
                  </td>
                  <td>{num(p.currentQuantity, 8)}</td>
                  <td>{price(p.currentAverage)}</td>
                  <td>{pct(p.valueAllocation)}</td>
                  <td>{pct(p.currentAllocation)}</td>
                  <td>{num(after(p.buy))}</td>
                  <td>{num(after(p.sell))}</td>
                  <td>{num(after(p.quantity), 8)}</td>
                  <td>{price(after(p.average))}</td>
                  <td>{pct(after(p.allocation))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
