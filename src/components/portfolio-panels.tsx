"use client";

import { Fragment, useState } from "react";
import Decimal from "decimal.js";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { buildExposure, type PositionGroup } from "@/lib/exposure";
import { assetNames } from "@/lib/asset-names";
import { formatPrice } from "@/lib/price-format";
import type { Dashboard, FuturesPosition } from "@/lib/types";
import { CoinIcon } from "./coin-icon";

const D = (v: string | number) => new Decimal(v);
function presentation(hidden: boolean) {
  return {
    n: (v: string | number | null | undefined, digits = 2, signed = false) => {
      if (hidden) return "••••";
      if (v === null || v === undefined) return "—";
      const d = D(v);
      return (
        (signed && !d.isZero() ? (d.isNegative() ? "−" : "+") : "") +
        (signed ? d.abs() : d).toNumber().toLocaleString("en-US", {
          minimumFractionDigits: digits === 2 ? 2 : 0,
          maximumFractionDigits: digits,
        })
      );
    },
    p: (v: string | null | undefined) => (hidden ? "••••" : formatPrice(v ?? null)),
    tone: (v: string | null | undefined) =>
      hidden || v == null || D(v).isZero() ? "" : D(v).isNegative() ? "negative" : "positive",
  };
}
export function HedgeStatus({ group }: { group: PositionGroup }) {
  return (
    <span
      className={`hedge-status ${group.status === "部分对冲" || group.status === "超额对冲" ? "partial" : ""}`}
    >
      {group.status}
    </span>
  );
}
export function ExposureStrip({ data, hidden }: { data: Dashboard; hidden: boolean }) {
  const e = buildExposure(data),
    { n } = presentation(hidden);
  return (
    <section
      className="exposure-strip"
      aria-label="组合风险敞口"
      title="同币种按同一参考价格计算敞口；稳定币不计入。不同币种的多空汇总不代表风险完全抵消。"
    >
      {[
        ["多头敞口", n(e.long), "USDT"],
        ["空头敞口", n(e.short), "USDT"],
        ["净敞口", n(e.net, 2, true), "USDT"],
        ["净敞口 / Equity", n(e.netRatio), "%"],
      ].map(([label, value, unit]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>
            {value}
            <small>{hidden ? "" : unit}</small>
          </strong>
        </div>
      ))}
      {!e.complete && (
        <p className="hedge-inline-note">
          仓位或行情待补齐，敞口暂不可用{e.unsupported.length ? " · 含非 USDT 合约" : ""}
        </p>
      )}
    </section>
  );
}
export function PositionSummary({ group: g, hidden }: { group: PositionGroup; hidden: boolean }) {
  const { n, tone } = presentation(hidden);
  return (
    <>
      <div className="hedge-card-heading">
        <strong>
          <CoinIcon asset={g.asset} compact />
          {g.asset}
        </strong>
        <HedgeStatus group={g} />
      </div>
      <div className="hedge-leg-grid">
        <div>
          <span>现货数量</span>
          <strong>{n(g.spotQuantity, 8)}</strong>
        </div>
        <div>
          <span>合约多 / 空</span>
          <strong>
            {g.netQuantity === null ? "—" : `${n(g.longQuantity, 8)} / ${n(g.shortQuantity, 8)}`}
          </strong>
        </div>
        <div>
          <span>净数量</span>
          <strong>{n(g.netQuantity, 8, true)}</strong>
        </div>
      </div>
      <div className="hedge-card-pnl">
        <span>组合持仓盈亏{!g.pnlComplete && " · 暂计"}</span>
        <strong className={tone(g.holdingPnl)}>
          {n(g.holdingPnl, 2, true)}
          <small>USDT</small>
        </strong>
      </div>
    </>
  );
}
function PositionLegs({ group: g, hidden }: { group: PositionGroup; hidden: boolean }) {
  const { n, p, tone } = presentation(hidden);
  const rows = [
    ...(g.spot
      ? [
          {
            id: "spot",
            label: "现货 · 多",
            short: false,
            qty: g.spotQuantity,
            cost: g.spot.averageCost,
            mark: g.spot.price,
            value: g.spot.value,
            pnl: g.spot.unrealizedPnl,
            rate:
              g.spot.averageCost !== null && D(g.spot.averageCost).gt(0) && g.spot.price !== null
                ? D(g.spot.price).div(g.spot.averageCost).minus(1).mul(100).toString()
                : null,
          },
        ]
      : []),
    ...g.positions.map((v) => ({
      id: v.symbol + ":" + v.positionSide,
      label: "永续 · " + (D(v.positionAmt).lt(0) ? "空" : "多"),
      short: D(v.positionAmt).lt(0),
      qty: D(v.positionAmt).abs().toString(),
      cost: v.entryPrice,
      mark: v.markPrice,
      value: D(v.markPrice).gt(0) ? D(v.positionAmt).abs().mul(v.markPrice).toString() : null,
      pnl: v.unRealizedProfit,
      rate: D(v.entryPrice).gt(0)
        ? D(v.unRealizedProfit).div(D(v.positionAmt).abs().mul(v.entryPrice)).mul(100).toString()
        : null,
    })),
  ];
  return (
    <>
      <div className="table-scroll">
        <table className="hedge-leg-table">
          <thead>
            <tr>
              <th>仓位</th>
              <th>数量</th>
              <th>成本 / 开仓均价</th>
              <th>标记价格</th>
              <th>市值 / 名义金额</th>
              <th>浮动盈亏 / 收益率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className={"hedge-status " + (r.short ? "short" : "")}>{r.label}</span>
                </td>
                <td>{n(r.qty, 8)}</td>
                <td>{p(r.cost)}</td>
                <td>{p(r.mark)}</td>
                <td>{n(r.value)}</td>
                <td className={tone(r.pnl)}>
                  {n(r.pnl, 2, true)}
                  <small>{g.stable ? "" : `（${n(r.rate, 2, true)}${hidden ? "" : "%"}）`}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {g.positions.length > 0 && (
        <div className="hedge-funding-line">
          <span>
            标的累计资金费净收入{" "}
            <strong className={tone(g.fundingPnl)}>{n(g.fundingPnl, 2, true)} USDT</strong>
          </span>
          {!g.pnlComplete && <span>流水待补齐</span>}
        </div>
      )}
    </>
  );
}
function FuturesRisk({ positions, hidden }: { positions: FuturesPosition[]; hidden: boolean }) {
  const { n, p } = presentation(hidden);
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>合约 / 方向</th>
            <th>保证金模式</th>
            <th>初始保证金 / U</th>
            <th>强平价格</th>
            <th>距强平价格</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((v) => {
            const liquidation =
              v.liquidationPrice && D(v.liquidationPrice).gt(0) ? v.liquidationPrice : null;
            const distance =
              liquidation && D(v.markPrice).gt(0)
                ? D(liquidation)
                    .minus(v.markPrice)
                    .mul(D(v.positionAmt).lt(0) ? 1 : -1)
                    .div(v.markPrice)
                    .mul(100)
                    .toString()
                : null;
            return (
              <tr key={v.symbol + ":" + v.positionSide}>
                <td>
                  {v.symbol}{" "}
                  <span className={"hedge-status " + (D(v.positionAmt).lt(0) ? "short" : "")}>
                    {D(v.positionAmt).lt(0) ? "空" : "多"}
                  </span>
                </td>
                <td>
                  {v.marginType === "isolated" ? "逐仓" : v.marginType === "cross" ? "全仓" : "—"}
                </td>
                <td>{n(v.initialMargin)}</td>
                <td>{p(liquidation)}</td>
                <td>
                  {n(distance)}
                  {distance !== null && !hidden ? "%" : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PortfolioHoldings({ data, hidden }: { data: Dashboard; hidden: boolean }) {
  const [mode, setMode] = useState<"combined" | "spot" | "futures">("combined");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [search, setSearch] = useState(""),
    [small, setSmall] = useState(false);
  const e = buildExposure(data),
    { n, p, tone } = presentation(hidden);
  const groups = e.groups
    .filter(
      (g) =>
        g.asset.toLowerCase().includes(search.toLowerCase()) ||
        (assetNames[g.asset] ?? "").includes(search),
    )
    .filter(
      (g) =>
        small ||
        (g.grossExposure ?? (g.positions.length ? null : g.spot?.value)) == null ||
        D(g.grossExposure ?? g.spot?.value ?? 0).gte(1),
    );
  const spot = groups.filter((g) => g.spot);
  const positions = groups.flatMap((g) => g.positions);
  const notional =
    e.positionsReady && !e.unsupported.length
      ? positions.reduce((v, a) => v.plus(D(a.positionAmt).abs().mul(a.markPrice)), D(0)).toString()
      : null;
  const allSpot = data.holdings.filter((h) => h.instrument !== "futures");
  const spotValue = allSpot.every((h) => h.value !== null)
    ? allSpot.reduce((v, h) => v.plus(h.value!), D(0)).toString()
    : null;
  return (
    <div className="portfolio-upgrade">
      <section className="exposure-strip">
        <div>
          <span>现货市值 · 含稳定币</span>
          <strong>
            {n(spotValue)}
            <small>USDT</small>
          </strong>
        </div>
        <div>
          <span>合约名义金额 · 当前筛选</span>
          <strong>
            {n(notional)}
            <small>USDT</small>
          </strong>
        </div>
        <div>
          <span>对冲标的</span>
          <strong>
            {hidden ? "••••" : e.positionsReady ? e.groups.filter((g) => g.hedged).length : "—"}
            <small>个</small>
          </strong>
        </div>
        <div>
          <span>持仓盈亏</span>
          <strong className={tone(data.summary.unrealizedPnl)}>
            {n(data.summary.unrealizedPnl, 2, true)}
            <small>USDT</small>
          </strong>
        </div>
      </section>
      <section className="panel portfolio-table-panel">
        <div className="panel-heading">
          <h2>资产持仓</h2>
          <div className="segmented">
            {[
              ["combined", "组合"],
              ["spot", "现货"],
              ["futures", "合约"],
            ].map(([id, label]) => (
              <button
                key={id}
                className={mode === id ? "selected" : ""}
                aria-pressed={mode === id}
                onClick={() => setMode(id as typeof mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="portfolio-filterbar">
          <label className="checkbox">
            <input type="checkbox" checked={small} onChange={(ev) => setSmall(ev.target.checked)} />
            展示小额资产
          </label>
          <label className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索币种"
              value={search}
              placeholder="搜索币种"
              onChange={(ev) => setSearch(ev.target.value)}
            />
          </label>
        </div>
        {!e.positionsReady && mode !== "spot" && (
          <p className="hedge-inline-note">合约持仓读取中，净数量和对冲状态暂不计算。</p>
        )}
        {e.unsupported.length > 0 && (
          <p className="hedge-inline-note">
            非 USDT 合约尚未纳入：{e.unsupported.map((v) => v.symbol).join("、")}
          </p>
        )}
        {mode === "combined" && (
          <div className="table-scroll">
            <table className="portfolio-group-table">
              <thead>
                <tr>
                  <th>资产</th>
                  <th>现货数量</th>
                  <th>合约多 / 空</th>
                  <th>净数量</th>
                  <th>对冲比例</th>
                  <th>组合持仓盈亏 / U</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.asset}>
                    <tr>
                      <td>
                        <button
                          className="portfolio-expand"
                          aria-expanded={expanded.includes(g.asset)}
                          onClick={() =>
                            setExpanded((v) =>
                              v.includes(g.asset)
                                ? v.filter((a) => a !== g.asset)
                                : [...v, g.asset],
                            )
                          }
                        >
                          {expanded.includes(g.asset) ? (
                            <ChevronDown size={15} />
                          ) : (
                            <ChevronRight size={15} />
                          )}
                          <CoinIcon asset={g.asset} />
                          <span>
                            <strong>{g.asset}</strong>
                            <small>{assetNames[g.asset] ?? "其他资产"}</small>
                            <HedgeStatus group={g} />
                          </span>
                        </button>
                      </td>
                      <td>{n(g.spotQuantity, 8)}</td>
                      <td>
                        {e.positionsReady
                          ? `${n(g.longQuantity, 8)} / ${n(g.shortQuantity, 8)}`
                          : "—"}
                      </td>
                      <td>{g.stable ? "—" : n(g.netQuantity, 8, true)}</td>
                      <td>
                        {g.stable || g.hedgeRatio === null
                          ? "—"
                          : `${n(g.hedgeRatio)}${hidden ? "" : "%"}`}
                      </td>
                      <td className={tone(g.holdingPnl)}>
                        {n(g.holdingPnl, 2, true)}
                        {!g.pnlComplete && !g.stable && <small>暂计</small>}
                      </td>
                    </tr>
                    {expanded.includes(g.asset) && (
                      <tr className="portfolio-expanded">
                        <td colSpan={6}>
                          <PositionLegs group={g} hidden={hidden} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {mode === "spot" && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>资产</th>
                  <th>数量 / 冻结</th>
                  <th>成本 / U</th>
                  <th>标记价格 / U</th>
                  <th>市值 / U</th>
                  <th>持仓盈亏 / 收益率</th>
                  <th>资产占比</th>
                </tr>
              </thead>
              <tbody>
                {spot.map((g) => {
                  const h = g.spot!;
                  const rate =
                    h.averageCost !== null && D(h.averageCost).gt(0) && h.price !== null
                      ? D(h.price).div(h.averageCost).minus(1).mul(100).toString()
                      : null;
                  return (
                    <tr key={g.asset}>
                      <td>
                        <div className="asset-cell">
                          <CoinIcon asset={g.asset} />
                          <div>
                            <strong>{g.asset}</strong>
                            <small>{assetNames[g.asset] ?? "其他资产"}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {n(h.quantity, 8)}
                        <small>冻结 {n(h.locked, 8)}</small>
                      </td>
                      <td>{p(h.averageCost)}</td>
                      <td>{p(h.price)}</td>
                      <td>{n(h.value)}</td>
                      <td className={tone(h.unrealizedPnl)}>
                        {g.stable ? (
                          "—"
                        ) : (
                          <>
                            {n(h.unrealizedPnl, 2, true)}
                            <small>
                              （{n(rate, 2, true)}
                              {hidden ? "" : "%"}）
                            </small>
                          </>
                        )}
                      </td>
                      <td>
                        {n(data.summary.equityComplete ? h.allocation : null)}
                        {hidden ? "" : "%"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {mode === "futures" && (
          <div className="portfolio-futures-list">
            {groups
              .filter((g) => g.positions.length)
              .map((g) => (
                <section key={g.asset}>
                  <div className="hedge-card-heading">
                    <strong>
                      <CoinIcon asset={g.asset} compact />
                      {g.asset}
                    </strong>
                    <HedgeStatus group={g} />
                  </div>
                  <PositionLegs group={{ ...g, spot: undefined }} hidden={hidden} />
                  <details className="hedge-risk-details">
                    <summary>保证金与强平信息</summary>
                    <FuturesRisk positions={g.positions} hidden={hidden} />
                  </details>
                </section>
              ))}
          </div>
        )}
        {((mode === "combined" && !groups.length) ||
          (mode === "spot" && !spot.length) ||
          (mode === "futures" && !positions.length)) && (
          <div className="overview-empty">
            {e.positionsReady || mode === "spot" ? "暂无匹配持仓" : "合约持仓待同步"}
          </div>
        )}
      </section>
      <section className="panel portfolio-cash">
        <h2>现金与保证金</h2>
        <div className="hedge-risk-grid">
          {[
            ["现货可用", data.summary.cashFree],
            ["现货冻结", data.summary.cashLocked],
            ["合约权益", data.summary.futuresEquity],
            ["合约保证金占用", data.summary.futuresInitialMargin],
            ["合约可用", data.summary.futuresAvailable],
          ].map(([label, value]) => (
            <div key={label}>
              <span>{label} · USDT</span>
              <strong>{n(value)}</strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function HedgePanel({ data, hidden }: { data: Dashboard; hidden: boolean }) {
  const e = buildExposure(data),
    { n, tone } = presentation(hidden);
  const groups = e.groups.filter((g) => g.hedged);
  const [selected, setSelected] = useState("");
  const current = groups.find((g) => g.asset === selected) ?? groups[0];
  const periods = data.hedgePeriods ?? {};
  const total = (key: "hedgedValue" | "netExposure") =>
    e.complete ? groups.reduce((v, g) => v.plus(g[key] ?? 0), D(0)).toString() : null;
  const periodTotal =
    groups.length && groups.every((g) => periods[g.asset]?.complete)
      ? groups.reduce((v, g) => v.plus(periods[g.asset].netPnl!), D(0)).toString()
      : null;
  const period = current ? periods[current.asset] : undefined;
  return (
    <div className="portfolio-upgrade">
      <section className="exposure-strip">
        <div>
          <span>同币种对冲组合</span>
          <strong>
            {hidden ? "••••" : e.positionsReady ? groups.length : "—"}
            <small>组</small>
          </strong>
        </div>
        <div>
          <span>已匹配对冲金额</span>
          <strong>
            {n(total("hedgedValue"))}
            <small>USDT</small>
          </strong>
        </div>
        <div>
          <span>组合剩余净敞口</span>
          <strong>
            {n(total("netExposure"), 2, true)}
            <small>USDT</small>
          </strong>
        </div>
        <div>
          <span>跟踪期间净损益</span>
          <strong className={tone(periodTotal)}>
            {n(periodTotal, 2, true)}
            <small>USDT</small>
          </strong>
        </div>
      </section>
      {!e.complete && <div className="notice">仓位或行情数据待补齐，暂不汇总敞口。</div>}
      {groups.length ? (
        <>
          <div className="hedge-cards">
            {groups.map((g) => (
              <button
                key={g.asset}
                className={"panel hedge-select " + (current.asset === g.asset ? "active" : "")}
                aria-pressed={current.asset === g.asset}
                onClick={() => setSelected(g.asset)}
              >
                <PositionSummary group={g} hidden={hidden} />
                <div className="hedge-ratio-label">
                  <span>对冲比例</span>
                  <strong>
                    {n(g.hedgeRatio)}
                    {hidden ? "" : "%"}
                  </strong>
                </div>
                <div className="hedge-ratio-track" aria-hidden="true">
                  <i
                    style={{
                      width: hidden ? "0%" : `${Math.min(100, Number(g.hedgeRatio ?? 0))}%`,
                    }}
                  />
                </div>
              </button>
            ))}
          </div>
          <section className="panel hedge-detail">
            <div className="overview-panel-heading">
              <div>
                <span className="overview-kicker">HEDGE ATTRIBUTION</span>
                <h2>{current.asset} 对冲明细</h2>
              </div>
              <div className="hedge-start">
                <span>开始记录</span>
                <strong>
                  {period
                    ? new Date(period.startedAt).toLocaleString("zh-CN", { hour12: false })
                    : "等待完整数据"}
                </strong>
              </div>
            </div>
            <PositionLegs group={current} hidden={hidden} />
            <div className="hedge-section">
              <h3>对冲期间损益</h3>
              <div className="hedge-attribution">
                {[
                  ["现货损益变化", period?.spotPnl],
                  ["合约损益", period?.futuresPnl],
                  ["资金费净收入", period?.fundingPnl],
                  ["交易手续费", period?.feePnl],
                  ["组合净损益", period?.netPnl],
                ].map(([label, value], i) => (
                  <div className={i === 4 ? "total" : ""} key={label}>
                    <span>{label}</span>
                    <strong className={tone(value)}>{n(value, 2, true)}</strong>
                  </div>
                ))}
              </div>
              <p className="hedge-inline-note">
                {period?.note ||
                  (period
                    ? "从首次完整记录起计算，包含期间交易；不回溯此前盈亏。"
                    : "完整成交与资金流水同步后开始记录。历史开仓前后的损益不作推算。")}
              </p>
            </div>
            <div className="hedge-section">
              <div className="overview-panel-heading">
                <h3>合约保证金</h3>
                <span className="hedge-available">
                  账户可用 {n(data.summary.futuresAvailable)} USDT
                </span>
              </div>
              <FuturesRisk positions={current.positions} hidden={hidden} />
            </div>
          </section>
        </>
      ) : (
        <section className="panel">
          <div className="overview-empty">
            {e.positionsReady ? "暂无同币种多空对冲组合" : "合约持仓待同步"}
          </div>
        </section>
      )}
    </div>
  );
}
