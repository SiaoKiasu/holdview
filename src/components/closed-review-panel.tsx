"use client";
import { useState } from "react";
import Decimal from "decimal.js";
import { ArrowDownLeft, ArrowUpRight, ChevronDown } from "lucide-react";
import type { ClosedReview } from "@/lib/closed-review";
import { formatPrice } from "@/lib/price-format";

export function ClosedReviewPanel({ review, hidden }: { review: ClosedReview; hidden: boolean }) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sort, setSort] = useState("time");
  const money = (n: string | number | null, digits = 2) =>
    hidden
      ? "••••"
      : n === null
        ? "—"
        : Number(n).toLocaleString("en-US", {
            minimumFractionDigits: digits === 2 ? 2 : 0,
            maximumFractionDigits: digits,
          });
  const price = (n: string | null) => (hidden ? "••••" : formatPrice(n));
  const signed = (n: string | null) =>
    hidden ? "••••" : n === null ? "—" : `${Number(n) > 0 ? "+" : ""}${money(n)}`;
  const tone = (n: string | null) =>
    hidden || n === null ? "" : Number(n) >= 0 ? "positive" : "negative";
  const duration = (ms: number | null) =>
    hidden
      ? "••••"
      : ms === null
        ? "—"
        : ms < 3600000
          ? `${Math.max(0, Math.round(ms / 60000))} 分钟`
          : ms < 86400000
            ? `${(ms / 3600000).toFixed(1)} 小时`
            : `${(ms / 86400000).toFixed(1)} 天`;
  const date = (n: number) =>
    new Date(n).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  const rows = review.rows
    .filter(
      (r) =>
        (filter === "all" || r.status === filter) &&
        r.asset.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .sort((a, b) =>
      sort === "time"
        ? b.lastCloseAt - a.lastCloseAt
        : a.netPnl === null
          ? 1
          : b.netPnl === null
            ? -1
            : Number(b.netPnl) - Number(a.netPnl),
    );
  const known = rows.filter((r) => r.netPnl !== null);
  const total = known.length
    ? known.reduce((n, r) => n.plus(r.netPnl!), new Decimal(0)).toString()
    : null;
  const basis = known.reduce((n, r) => n.plus(r.cost ?? 0), new Decimal(0));
  const rate =
    total !== null && basis.gt(0) ? new Decimal(total).div(basis).mul(100).toString() : null;
  const winners = known.filter((r) => Number(r.netPnl) > 0).length;
  const active = rows.find((r) => r.id === expanded);
  return (
    <div className="review-page">
      <div className="review-stats">
        <section className="stat">
          <div className="stat-label">
            平仓净收益{" "}
            {(!review.complete || known.length !== rows.length) && (
              <span className="subtle-tag">暂计</span>
            )}
          </div>
          <div className={`stat-value ${tone(total)}`}>
            {signed(total)} <small>USDT</small>
          </div>
        </section>
        <section className="stat">
          <div className="stat-label">已平部分收益率</div>
          <div className={`stat-value ${tone(rate)}`}>
            {signed(rate)}
            <small>%</small>
          </div>
        </section>
        <section className="stat">
          <div className="stat-label">盈利占比 · 仓位</div>
          <div className="stat-value">
            {hidden ? "••••" : known.length ? ((winners / known.length) * 100).toFixed(1) : "—"}
            <small>%</small>
          </div>
          <small className="muted-text">
            {hidden ? "••••" : `${winners} 盈利 / ${known.length - winners} 未盈利`}
          </small>
        </section>
        <section className="stat">
          <div className="stat-label">已清仓 / 部分平仓</div>
          <div className="stat-value">
            {hidden
              ? "••••"
              : `${rows.filter((r) => r.status === "closed").length} / ${rows.filter((r) => r.status === "partial").length}`}
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>
            币种累计 <span className="count">{rows.length}</span>
          </h2>
          <span className="muted-text">剩余估值 &lt; 1 USDT 视为已清仓</span>
        </div>
        <div className="filterbar">
          <div className="segmented">
            {[
              ["all", "全部平仓"],
              ["closed", "已清仓"],
              ["partial", "部分平仓"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={filter === key ? "selected" : ""}
                onClick={() => {
                  setFilter(key);
                  setExpanded(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="review-filters">
            <input
              aria-label="搜索复盘币种"
              placeholder="搜索币种"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select aria-label="复盘排序" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="time">最近平仓</option>
              <option value="pnl">收益优先</option>
            </select>
          </div>
        </div>
        <div className="table-scroll">
          <table className="review-table">
            <thead>
              <tr>
                {[
                  "资产 / 状态",
                  "已平数量",
                  "匹配开仓均价",
                  "平仓均价",
                  "平仓净收益 (USDT)",
                  "收益率",
                  "买卖手续费 (USDT)",
                  "平均持有",
                  "剩余估值 (USDT)",
                  "最近平仓",
                  "",
                ].map((v, i) => (
                  <th key={i}>{v}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={expanded === r.id ? "review-selected" : ""}>
                  <td>
                    <strong>{r.asset}</strong>
                    <small>
                      {r.status === "closed"
                        ? "已清仓"
                        : r.status === "partial"
                          ? "部分平仓"
                          : "状态待确认"}
                      {!r.complete ? " · 暂计" : ""}
                    </small>
                  </td>
                  <td className="numeric">{money(r.quantity, 8)}</td>
                  <td className="numeric">{price(r.averageEntry)}</td>
                  <td className="numeric">{price(r.averageExit)}</td>
                  <td className={`numeric ${tone(r.netPnl)}`}>
                    <strong>{signed(r.netPnl)}</strong>
                    {r.netPnl === null && <small>记录待补齐</small>}
                  </td>
                  <td className={`numeric ${tone(r.returnRate)}`}>
                    {signed(r.returnRate)}
                    {r.returnRate === null ? "" : "%"}
                  </td>
                  <td className="numeric">{money(r.fees)}</td>
                  <td>{duration(r.holdingMs)}</td>
                  <td className="numeric">{money(r.remainingValue)}</td>
                  <td>{date(r.lastCloseAt)}</td>
                  <td>
                    <button
                      className="text-button"
                      aria-expanded={expanded === r.id}
                      onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    >
                      明细 <ChevronDown size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <div className="empty">{review.complete ? "暂无匹配的平仓记录" : "平仓记录待同步"}</div>
          )}
        </div>
        <div className="review-note">
          净收益扣除已平部分对应的买卖手续费；资金费仍计入持仓盈亏。
        </div>
      </section>
      {active && (
        <section className="panel">
          <div className="panel-heading">
            <h2>{active.asset} · 平仓明细</h2>
            <span className="muted-text">
              共 {active.closeCount} 笔{active.closeCount > 100 ? " · 最近 100 笔" : ""}
            </span>
          </div>
          <div className="review-detail-stats">
            <span>
              匹配成本 <strong>{money(active.cost)} USDT</strong>
            </span>
            <span>
              平仓毛收益{" "}
              <strong className={tone(active.grossPnl)}>{signed(active.grossPnl)} USDT</strong>
            </span>
            <span>
              手续费 <strong>{money(active.fees)} USDT</strong>
            </span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    "平仓时间",
                    "数量",
                    "匹配开仓价",
                    "平仓价",
                    "手续费",
                    "净收益",
                    "收益率",
                    "持有时间",
                  ].map((x) => (
                    <th key={x}>{x}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {active.fills.map((f) => (
                  <tr key={f.id}>
                    <td>{date(f.time)}</td>
                    <td className="numeric">{money(f.quantity, 8)}</td>
                    <td className="numeric">{price(f.entryPrice)}</td>
                    <td className="numeric">{price(f.exitPrice)}</td>
                    <td className="numeric">{money(f.fees)}</td>
                    <td className={`numeric ${tone(f.netPnl)}`}>{signed(f.netPnl)}</td>
                    <td className={`numeric ${tone(f.returnRate)}`}>
                      {signed(f.returnRate)}
                      {f.returnRate === null ? "" : "%"}
                    </td>
                    <td>{duration(f.holdingMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {rows.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <h2>收益对比</h2>
            <span className="muted-text">USDT</span>
          </div>
          <div className="review-bars">
            {[...known]
              .sort((a, b) => Math.abs(Number(b.netPnl)) - Math.abs(Number(a.netPnl)))
              .slice(0, 12)
              .map((r) => (
                <div className="review-bar-row" key={r.id}>
                  <strong>{r.asset}</strong>
                  <div className="review-bar-track">
                    {!hidden && (
                      <i
                        className={Number(r.netPnl) >= 0 ? "gain" : "loss"}
                        style={{
                          width: `${Math.max(1, (Math.abs(Number(r.netPnl)) / Math.max(...known.map((x) => Math.abs(Number(x.netPnl))), 1)) * 100)}%`,
                        }}
                      />
                    )}
                  </div>
                  <strong className={tone(r.netPnl)}>
                    {!hidden &&
                      (Number(r.netPnl) >= 0 ? (
                        <ArrowUpRight size={13} />
                      ) : (
                        <ArrowDownLeft size={13} />
                      ))}
                    {signed(r.netPnl)}
                  </strong>
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
