"use client";

import type { ReactNode } from "react";
import Decimal from "decimal.js";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { STABLECOINS } from "@/lib/assets";
import type { Dashboard } from "@/lib/types";

const D = (v: string | number) => new Decimal(v);
const palette = ["#355b49", "#b7a475", "#91a995"];

export function OverviewPanel({
  data,
  hidden,
  period,
  onPeriod,
  onNavigate,
  chart,
}: {
  data: Dashboard;
  hidden: boolean;
  period: number;
  onPeriod: (period: number) => void;
  onNavigate: (tab: "holdings" | "activity" | "plan") => void;
  chart: ReactNode;
}) {
  const { summary: s } = data;
  const fmt = (v: string | number | null, signed = false) => {
    if (hidden) return "••••";
    if (v === null) return "—";
    const n = D(v);
    return (
      (signed && !n.isZero() ? (n.isPositive() ? "+" : "−") : "") +
      (signed ? n.abs() : n)
        .toNumber()
        .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    );
  };
  const tone = (v: string | null) =>
    hidden || v === null || D(v).isZero() ? "" : D(v).isNegative() ? "negative" : "positive";
  const spot = data.holdings.filter((h) => h.instrument !== "futures");
  const sum = (stable: boolean) =>
    spot
      .filter((h) => STABLECOINS.has(h.asset) === stable)
      .reduce((n, h) => n.plus(h.value ?? 0), D(0))
      .toString();
  const buckets = [
    { label: "现货持仓", value: sum(false), color: palette[0] },
    { label: "稳定币", value: sum(true), color: palette[1] },
    ...(data.connection.futuresEnabled
      ? [{ label: "合约权益", value: s.futuresEquity ?? null, color: palette[2] }]
      : []),
  ];
  const allocationTotal = buckets.reduce((n, b) => n.plus(b.value ?? 0), D(0));
  const allocationReady =
    s.equityComplete &&
    buckets.every((b) => b.value !== null && D(b.value).gte(0)) &&
    allocationTotal.gt(0);
  const ratio = (v: string | null) =>
    allocationReady && v !== null ? D(v).div(allocationTotal).mul(100).toNumber() : null;
  const active = data.holdings.filter(
    (h) =>
      !STABLECOINS.has(h.asset) &&
      h.direction !== "已平仓" &&
      (h.value === null || D(h.value).abs().gte(1)),
  );
  const focus = [...active]
    .sort((a, b) => {
      if (a.unrealizedPnl === null) return b.unrealizedPnl === null ? 0 : 1;
      if (b.unrealizedPnl === null) return -1;
      return D(b.unrealizedPnl).abs().cmp(D(a.unrealizedPnl).abs());
    })
    .slice(0, 4);
  const maxPnl = Math.max(1, ...focus.map((h) => Math.abs(Number(h.unrealizedPnl))));
  const snapshots = data.history
    .filter((h) => h.time >= Date.now() - period * 86400000)
    .sort((a, b) => a.time - b.time);
  const change =
    snapshots.length >= 2
      ? D(snapshots.at(-1)!.equity).minus(snapshots[0].equity).toString()
      : null;
  const latest = [...data.trades].sort((a, b) => b.time - a.time)[0];
  const date = (at: number) =>
    new Date(at).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  const ordersReady = data.connection.ordersComplete;
  return (
    <div className="overview-dashboard">
      <section className="overview-hero">
        <div className="overview-wealth">
          <div className="overview-eyebrow">
            PORTFOLIO OVERVIEW <span>{data.accountLabel}</span>
          </div>
          <div className="overview-equity-label">
            {s.equityComplete ? "总资产估值" : "已估值资产小计"} <span>EQUITY</span>
            {s.equitySource === "calculated" && <span className="overview-estimate">估算</span>}
          </div>
          <div className="overview-equity">
            {fmt(s.equity)}
            <span>USDT</span>
          </div>
          <div className="overview-principal">
            <span>账户本金</span>
            <strong>{s.principal === null ? "未设置" : fmt(s.principal) + " USDT"}</strong>
          </div>
        </div>
        <div className="overview-results">
          <div>
            <span>
              已实现盈亏 {!s.realizedPnlComplete && s.realizedPnl !== null && <small>暂计</small>}
            </span>
            <strong className={tone(s.realizedPnl)}>
              {fmt(s.realizedPnl, true)}
              <small>USDT</small>
            </strong>
            {s.realizedPnl === null && (
              <small className="overview-pending">{s.realizedPnlNote || "数据待同步"}</small>
            )}
          </div>
          <div>
            <span>
              持仓盈亏{" "}
              {s.holdingPnlComplete === false && s.unrealizedPnl !== null && <small>暂计</small>}
            </span>
            <strong className={tone(s.unrealizedPnl)}>
              {fmt(s.unrealizedPnl, true)}
              <small>USDT</small>
            </strong>
            {s.unrealizedPnl === null && (
              <small className="overview-pending">成本或行情待补齐</small>
            )}
          </div>
        </div>
      </section>

      <div className="overview-main-grid">
        <section className="panel overview-trend">
          <div className="overview-panel-heading">
            <div>
              <span className="overview-kicker">PERFORMANCE</span>
              <h2>资产走势</h2>
            </div>
            <div className="segmented">
              {[
                { d: 1, label: "24H" },
                { d: 7, label: "7D" },
                { d: 30, label: "30D" },
                { d: 90, label: "90D" },
              ].map((p) => (
                <button
                  key={p.d}
                  className={period === p.d ? "selected" : ""}
                  onClick={() => onPeriod(p.d)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="overview-period">
            <strong className={tone(change)}>
              {fmt(change, true)}
              <small>USDT</small>
            </strong>
            <span title="所选期间内首末资产估值之差，包含资金进出，不代表投资收益。">
              区间资产变化
            </span>
          </div>
          {chart}
        </section>

        <section className="panel overview-capital">
          <div className="overview-panel-heading">
            <div>
              <span className="overview-kicker">ALLOCATION</span>
              <h2>资金配置</h2>
            </div>
            <span className="overview-unit">USDT</span>
          </div>
          <div className="overview-allocation-bar" aria-label="资金配置比例">
            {!hidden && allocationReady ? (
              buckets.map((b) => (
                <span key={b.label} style={{ width: ratio(b.value)! + "%", background: b.color }} />
              ))
            ) : (
              <span className="overview-bar-placeholder" />
            )}
          </div>
          <div className="overview-capital-list">
            {buckets.map((b) => (
              <div key={b.label}>
                <span>
                  <i style={{ background: b.color }} />
                  {b.label}
                </span>
                <strong>{fmt(b.value)}</strong>
                <small>
                  {hidden
                    ? "••••"
                    : ratio(b.value) === null
                      ? "—"
                      : ratio(b.value)!.toFixed(1) + "%"}
                </small>
              </div>
            ))}
          </div>
          <div className="overview-capital-basis">
            已估值资产占比{!s.equityComplete && " · 数据待补齐"}
          </div>
          <div className="overview-liquidity">
            <div>
              <span>可用现金 · USDT</span>
              <strong>{fmt(s.cashFree)}</strong>
            </div>
            <div>
              <span>冻结现金 · USDT</span>
              <strong>{fmt(s.cashLocked)}</strong>
            </div>
          </div>
          <button className="overview-link" onClick={() => onNavigate("holdings")}>
            查看资产持仓 <ArrowRight size={15} />
          </button>
        </section>
      </div>

      <div className="overview-bottom-grid">
        <section className="panel overview-focus">
          <div className="overview-panel-heading">
            <div>
              <span className="overview-kicker">POSITIONS</span>
              <h2>
                持仓表现 <span className="count">{active.length}</span>
              </h2>
            </div>
            <button className="overview-link" onClick={() => onNavigate("holdings")}>
              全部持仓 <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="overview-focus-label">
            <span>按盈亏绝对值排序 · 前四项</span>
            <span>持仓盈亏 / 收益率</span>
          </div>
          {focus.length ? (
            focus.map((h, i) => {
              const rate =
                h.instrument === "futures"
                  ? (h.returnRate ?? null)
                  : h.price !== null && h.averageCost !== null && D(h.averageCost).gt(0)
                    ? D(h.price).div(h.averageCost).minus(1).mul(100).toString()
                    : null;
              const pnl = Number(h.unrealizedPnl);
              const width =
                hidden || h.unrealizedPnl === null
                  ? 0
                  : Math.min(50, (Math.abs(pnl) / maxPnl) * 50);
              return (
                <div
                  className="overview-position"
                  key={(h.instrument ?? "spot") + ":" + (h.symbol ?? h.asset)}
                >
                  <span className="overview-position-rank">{String(i + 1).padStart(2, "0")}</span>
                  <strong>{h.asset}</strong>
                  <div className="overview-pnl-track">
                    <i
                      style={{
                        left: pnl < 0 ? 50 - width + "%" : "50%",
                        width: width + "%",
                        background: pnl < 0 ? "#bf8f7d" : "#648873",
                      }}
                    />
                    <span />
                  </div>
                  <div className="overview-position-result">
                    <strong className={tone(h.unrealizedPnl)}>{fmt(h.unrealizedPnl, true)}</strong>
                    <small>
                      {rate === null ? "—" : fmt(rate, true) + (hidden ? "" : "%")}
                      {h.pnlComplete === false && " · 暂计"}
                    </small>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="overview-empty">暂无持仓</div>
          )}
        </section>

        <section className="panel overview-activity">
          <div className="overview-panel-heading">
            <div>
              <span className="overview-kicker">ACTIVITY</span>
              <h2>交易动态</h2>
            </div>
            <button className="overview-link" onClick={() => onNavigate("activity")}>
              交易记录 <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="overview-orders">
            <div>
              <span>当前挂单</span>
              <strong>
                {ordersReady ? data.orders.length : "—"}
                <small>笔</small>
              </strong>
            </div>
            <div>
              <span>买入</span>
              <strong>
                {ordersReady ? data.orders.filter((o) => o.side === "BUY").length : "—"}
              </strong>
            </div>
            <div>
              <span>卖出</span>
              <strong>
                {ordersReady ? data.orders.filter((o) => o.side === "SELL").length : "—"}
              </strong>
            </div>
          </div>
          <div className="overview-latest">
            <span>最近成交{!data.connection.tradesComplete && <small> · 已同步记录</small>}</span>
            {latest ? (
              <>
                <div>
                  <strong>{latest.symbol}</strong>
                  <span
                    className={"overview-trade-side " + (latest.side === "BUY" ? "buy" : "sell")}
                  >
                    {latest.side === "BUY" ? "买入" : "卖出"}
                  </span>
                  <time>{date(latest.time)}</time>
                </div>
              </>
            ) : (
              <p>{data.connection.tradesComplete ? "暂无成交" : "成交待同步"}</p>
            )}
          </div>
          <button className="overview-link overview-plan-link" onClick={() => onNavigate("plan")}>
            查看交易计划 <ArrowRight size={15} />
          </button>
        </section>
      </div>
    </div>
  );
}
