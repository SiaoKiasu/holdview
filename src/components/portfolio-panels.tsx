"use client";

import { Fragment, useState } from "react";
import Decimal from "decimal.js";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { buildExposure, type PositionGroup } from "@/lib/exposure";
import { contractLabel, positionBasis, positionNotional } from "@/lib/futures-units";
import { physicalHoldings } from "@/lib/physical-holdings";
import { STABLECOINS } from "@/lib/assets";
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
          仓位或行情待补齐，敞口暂不可用{e.unsupported.length ? " · 含待换算合约" : ""}
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
          {D(g.collateralQuantity).abs().gt(0) && (
            <small className="collateral-quantity">保证金币 {n(g.collateralQuantity, 8)}</small>
          )}
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
    ...(D(g.collateralQuantity).abs().gt(0)
      ? [
          {
            id: "collateral",
            label: "币本位保证金币",
            short: false,
            qty: g.collateralWallet?.walletBalance ?? g.collateralQuantity,
            cost: g.collateralWallet?.averageCost ?? null,
            mark: g.collateralPrice,
            value: g.collateralPrice
              ? D(g.collateralWallet?.walletBalance ?? g.collateralQuantity)
                  .mul(g.collateralPrice)
                  .toString()
              : null,
            pnl: g.collateralWallet?.holdingPnl ?? null,
            rate:
              g.collateralWallet?.averageCost &&
              D(g.collateralWallet.averageCost).gt(0) &&
              g.collateralPrice
                ? D(g.collateralPrice)
                    .div(g.collateralWallet.averageCost)
                    .minus(1)
                    .mul(100)
                    .toString()
                : null,
          },
        ]
      : []),
    ...g.positions.map((v) => ({
      id: v.symbol + ":" + v.positionSide,
      label: contractLabel(v) + " · " + (D(v.positionAmt).lt(0) ? "空" : "多"),
      short: D(v.positionAmt).lt(0),
      qty: D(v.positionAmt).abs().toString(),
      cost: v.entryPrice,
      mark: v.markPrice,
      value: D(v.markPrice).gt(0) ? positionNotional(v).toString() : null,
      pnl: v.unRealizedProfit,
      rate: D(v.entryPrice).gt(0)
        ? D(v.unRealizedProfit).div(positionBasis(v)).mul(100).toString()
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

function FuturesHoldingsTable({ groups, hidden }: { groups: PositionGroup[]; hidden: boolean }) {
  const [open, setOpen] = useState<string[]>([]);
  const { n, p, tone } = presentation(hidden);
  return (
    <div className="table-scroll futures-table-scroll">
      <table className="futures-holdings-table">
        <thead>
          <tr>
            <th>合约</th>
            <th>方向</th>
            <th>持仓数量</th>
            <th>开仓均价</th>
            <th>标记价格</th>
            <th>名义金额 / U</th>
            <th>浮动盈亏 / U</th>
            <th aria-label="展开明细" />
          </tr>
        </thead>
        <tbody>
          {groups
            .filter((g) => g.positions.length)
            .map((g) => {
              const expanded = open.includes(g.asset);
              const toggle = () =>
                setOpen((v) => (expanded ? v.filter((a) => a !== g.asset) : [...v, g.asset]));
              return (
                <Fragment key={g.asset}>
                  {g.positions.map((position, index) => {
                    const quantity = D(position.positionAmt).abs();
                    const basis = positionBasis(position);
                    const rate = basis.gt(0)
                      ? D(position.unRealizedProfit).div(basis).mul(100).toString()
                      : null;
                    const short = D(position.positionAmt).lt(0);
                    return (
                      <tr
                        key={`${position.symbol}:${position.positionSide}`}
                        className={expanded ? "is-expanded" : ""}
                      >
                        <td>
                          <button
                            className="futures-asset-button"
                            onClick={toggle}
                            aria-expanded={expanded}
                            aria-label={`${g.asset} ${short ? "空头" : "多头"}仓位明细`}
                          >
                            <CoinIcon asset={g.asset === "1000PEPE" ? "PEPE" : g.asset} />
                            <span>
                              <strong>{g.asset}</strong>
                              <small>
                                {contractLabel(position)}
                                {g.hedged ? ` · ${g.status}` : ""}
                              </small>
                            </span>
                          </button>
                        </td>
                        <td>
                          <span className={`futures-direction ${short ? "short" : "long"}`}>
                            <i />
                            {short ? "空头" : "多头"}
                          </span>
                        </td>
                        <td>
                          {position.contractMarket === "coin" ? (
                            <>
                              {n(D(position.contracts!).abs().toString(), 0)} 张
                              <small>
                                ≈ {n(quantity.toString(), 8)} {g.asset}
                              </small>
                            </>
                          ) : (
                            n(quantity.toString(), 8)
                          )}
                        </td>
                        <td>
                          {p(position.entryPrice)}
                          <small>{position.contractMarket === "coin" ? "USD" : "USDT"}</small>
                        </td>
                        <td>
                          {p(position.markPrice)}
                          <small>{position.contractMarket === "coin" ? "USD" : "USDT"}</small>
                        </td>
                        <td>
                          {n(
                            D(position.markPrice).gt(0)
                              ? positionNotional(position).toString()
                              : null,
                          )}
                        </td>
                        <td className="futures-row-pnl">
                          <strong className={tone(position.unRealizedProfit)}>
                            {n(position.unRealizedProfit, 2, true)}
                          </strong>
                          <small className={tone(position.unRealizedProfit)}>
                            {n(rate, 2, true)}
                            {!hidden && rate !== null ? "%" : ""}
                          </small>
                        </td>
                        <td>
                          <button
                            className="futures-detail-toggle"
                            onClick={toggle}
                            aria-expanded={expanded}
                            aria-label={`${expanded ? "收起" : "展开"} ${g.asset} ${index + 1} 明细`}
                          >
                            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {expanded && (
                    <tr className="futures-detail-row">
                      <td colSpan={8}>
                        <div className="futures-detail-content">
                          <div className="futures-detail-heading">
                            <strong>{g.asset} · 仓位明细</strong>
                            <span>
                              累计资金费{" "}
                              <b className={tone(g.fundingPnl)}>{n(g.fundingPnl, 2, true)}</b> USDT
                              {!g.pnlComplete ? " · 流水待补齐" : ""}
                            </span>
                          </div>
                          <FuturesRisk positions={g.positions} hidden={hidden} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

export function PortfolioHoldings({ data, hidden }: { data: Dashboard; hidden: boolean }) {
  const [mode, setMode] = useState<"combined" | "spot" | "futures">("spot");
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
  const allSpot = physicalHoldings(data);
  const spot = allSpot.filter(
    (h) =>
      (h.asset.toLowerCase().includes(search.toLowerCase()) ||
        (assetNames[h.asset] ?? "").includes(search)) &&
      (small || h.value === null || D(h.value).gte(1)),
  );
  const positions = groups.flatMap((g) => g.positions);
  const notional =
    e.positionsReady && !e.unsupported.length
      ? positions.reduce((v, a) => v.plus(positionNotional(a)), D(0)).toString()
      : null;
  const spotValue = allSpot.every((h) => h.value !== null)
    ? allSpot.reduce((v, h) => v.plus(h.value!), D(0)).toString()
    : null;
  const futuresPnl =
    e.positionsReady && !e.unsupported.length
      ? positions.reduce((v, a) => v.plus(a.unRealizedProfit), D(0)).toString()
      : null;
  const spotPnl = allSpot.filter((h) => !STABLECOINS.has(h.asset));
  const shownPnl =
    mode === "futures"
      ? futuresPnl
      : mode === "spot"
        ? spotPnl.every((h) => h.unrealizedPnl !== null)
          ? spotPnl.reduce((n, h) => n.plus(h.unrealizedPnl!), D(0)).toString()
          : null
        : data.summary.unrealizedPnl;
  return (
    <div className="portfolio-upgrade">
      <section className="exposure-strip">
        <div>
          <span>{mode === "futures" ? "合约权益" : "币资产市值 · 含保证金币"}</span>
          <strong>
            {n(mode === "futures" ? data.summary.futuresEquity : spotValue)}
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
          <span>{mode === "futures" ? "保证金占用" : "对冲标的"}</span>
          <strong>
            {mode === "futures"
              ? n(data.summary.futuresInitialMargin)
              : hidden
                ? "••••"
                : e.positionsReady
                  ? e.groups.filter((g) => g.hedged).length
                  : "—"}
            <small>{mode === "futures" ? "USDT" : "个"}</small>
          </strong>
        </div>
        <div>
          <span>{mode === "futures" ? "浮动盈亏 · 当前筛选" : "持仓盈亏"}</span>
          <strong className={tone(shownPnl)}>
            {n(shownPnl, 2, true)}
            <small>USDT</small>
          </strong>
        </div>
      </section>
      <section className="panel portfolio-table-panel">
        <div className="portfolio-toolbar">
          <div className="portfolio-toolbar-heading">
            <h2>资产持仓</h2>
            <div className="segmented">
              {[
                ["spot", "现货"],
                ["futures", "合约"],
                ["combined", "组合"],
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
              <input
                type="checkbox"
                checked={small}
                onChange={(ev) => setSmall(ev.target.checked)}
              />
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
        </div>
        {!e.positionsReady && mode !== "spot" && (
          <p className="hedge-inline-note">合约持仓读取中，净数量和对冲状态暂不计算。</p>
        )}
        {e.unsupported.length > 0 && (
          <p className="hedge-inline-note">
            待换算合约尚未纳入：{e.unsupported.map((v) => v.symbol).join("、")}
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
                      <td>
                        {n(g.spotQuantity, 8)}
                        {D(g.collateralQuantity).abs().gt(0) && (
                          <small className="collateral-quantity">
                            保证金币 {n(g.collateralQuantity, 8)}
                          </small>
                        )}
                      </td>
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
                {spot.map((h) => {
                  const book = data.coinInventory?.[h.asset];
                  const wallet = data.coinWallets?.find((w) => w.asset === h.asset);
                  const opened = expanded.includes(h.asset);
                  const rate =
                    h.averageCost !== null && D(h.averageCost).gt(0) && h.price !== null
                      ? D(h.price).div(h.averageCost).minus(1).mul(100).toString()
                      : null;
                  return (
                    <Fragment key={h.asset}>
                      <tr>
                        <td>
                          <button
                            className="futures-asset-button"
                            disabled={!book && !wallet}
                            aria-label={`${h.asset} 币资产明细`}
                            aria-expanded={opened}
                            onClick={() =>
                              setExpanded((v) =>
                                opened ? v.filter((a) => a !== h.asset) : [...v, h.asset],
                              )
                            }
                          >
                            <CoinIcon asset={h.asset} />
                            <span>
                              <strong>{h.asset}</strong>
                              <small>{assetNames[h.asset] ?? "其他资产"}</small>
                              {D(h.walletQuantity).gt(0) && (
                                <small className="coin-location-tag">含保证金币</small>
                              )}
                            </span>
                            {(book || wallet) &&
                              (opened ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                          </button>
                        </td>
                        <td>
                          {n(h.quantity, 8)}
                          <small>现货冻结 {n(h.locked, 8)}</small>
                        </td>
                        <td>
                          {p(h.averageCost)}
                          {book && <small>{book.complete ? "账本均价" : "账本待核对"}</small>}
                        </td>
                        <td>{p(h.price)}</td>
                        <td>{n(h.value)}</td>
                        <td className={tone(h.unrealizedPnl)}>
                          {STABLECOINS.has(h.asset) ? (
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
                      {opened && (book || wallet) && (
                        <tr className="portfolio-expanded">
                          <td colSpan={7}>
                            <div className="coin-inventory-detail">
                              <div className="coin-inventory-heading">
                                <h3>{h.asset} 币资产账本</h3>
                                <span>现货与保证金币统一加权成本</span>
                              </div>
                              <div className="coin-inventory-grid">
                                <div>
                                  <span>现货钱包 · {h.asset}</span>
                                  <strong>{n(h.spotQuantity, 8)}</strong>
                                </div>
                                <div>
                                  <span>保证金钱包 · {h.asset}</span>
                                  <strong>{n(h.walletQuantity, 8)}</strong>
                                </div>
                                <div>
                                  <span>持币成本 · USDT</span>
                                  <strong>{n(book?.cost)}</strong>
                                </div>
                                <div>
                                  <span>币价盈亏 · USDT</span>
                                  <strong className={tone(h.unrealizedPnl)}>
                                    {n(h.unrealizedPnl, 2, true)}
                                  </strong>
                                </div>
                              </div>
                              {book && (
                                <div className="coin-settlement-table">
                                  <table>
                                    <thead>
                                      <tr>
                                        <th>已结算流水</th>
                                        <th>币数量 · {h.asset}</th>
                                        <th>发生时折算 · USDT</th>
                                        <th>计入</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {[
                                        [
                                          "合约平仓",
                                          book.realizedCoin,
                                          book.realizedValue,
                                          "已实现盈亏",
                                        ],
                                        ["资金费", book.fundingCoin, book.fundingValue, "持仓盈亏"],
                                        [
                                          "合约手续费",
                                          book.commissionCoin,
                                          book.commissionValue,
                                          "已实现盈亏",
                                        ],
                                      ].map(([label, qty, value, destination]) => (
                                        <tr key={label!}>
                                          <td>{label}</td>
                                          <td className={tone(qty)}>{n(qty, 8, true)}</td>
                                          <td className={tone(value)}>{n(value, 2, true)}</td>
                                          <td>{destination}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                              <div className="coin-inventory-footer">
                                <span>
                                  合约未结算 {n(wallet?.unrealizedProfit, 8, true)} {h.asset} ·
                                  不计入持币数量
                                </span>
                                <span>
                                  币支付价差 {n(book?.disposalPnl, 2, true)} USDT · 已计入已实现盈亏
                                </span>
                              </div>
                              {book && !book.complete && (
                                <p className="negative">{book.issues.join(" · ")}</p>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {mode === "futures" && <FuturesHoldingsTable groups={groups} hidden={hidden} />}
        {((mode === "combined" && !groups.length) ||
          (mode === "spot" && !spot.length) ||
          (mode === "futures" && !positions.length)) && (
          <div className="overview-empty">
            {e.positionsReady || mode === "spot" ? "暂无匹配持仓" : "合约持仓待同步"}
          </div>
        )}
      </section>
      {(data.coinWallets?.length ?? 0) > 0 && (
        <section className="panel portfolio-cash">
          <h2>币本位钱包</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>保证金币</th>
                  <th>钱包余额</th>
                  <th>未结算盈亏 · 币</th>
                  <th>账户权益 · 币</th>
                  <th>权益折算 / USDT</th>
                </tr>
              </thead>
              <tbody>
                {data.coinWallets!.map((w) => (
                  <tr key={w.asset}>
                    <td>{w.asset}</td>
                    <td>{n(w.walletBalance, 8)}</td>
                    <td className={tone(w.unrealizedProfit)}>{n(w.unrealizedProfit, 8, true)}</td>
                    <td>{n(w.marginBalance, 8)}</td>
                    <td>{n(D(w.marginBalance).mul(w.price).toString())}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
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
    { n, p, tone } = presentation(hidden);
  const groups = e.groups.filter((g) => g.hedged);
  const [expandedAssets, setExpandedAssets] = useState<string[]>([]);
  const periods = data.hedgePeriods ?? {};
  const total = (key: "hedgedValue" | "netExposure") =>
    e.complete ? groups.reduce((v, g) => v.plus(g[key] ?? 0), D(0)).toString() : null;
  const periodTotal =
    groups.length && groups.every((g) => periods[g.asset]?.complete)
      ? groups.reduce((v, g) => v.plus(periods[g.asset].netPnl!), D(0)).toString()
      : null;
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
          <section className="panel hedge-comparison-panel">
            <div className="hedge-comparison-heading">
              <div>
                <span className="overview-kicker">HEDGE POSITIONS</span>
                <h2>
                  对冲持仓 <span className="count">{groups.length}</span>
                </h2>
              </div>
              <span>盈亏 / 敞口 · USDT</span>
            </div>
            <div className="table-scroll">
              <table className="hedge-comparison-table">
                <thead>
                  <tr>
                    <th>标的 / 状态</th>
                    <th>合约仓位</th>
                    <th>入场价格</th>
                    <th>标记价格</th>
                    <th>强平价格</th>
                    <th>合约浮动盈亏</th>
                    <th>组合持仓盈亏</th>
                    <th>对冲比例 / 净敞口</th>
                  </tr>
                </thead>
                {groups.map((g) => {
                  const expanded = expandedAssets.includes(g.asset);
                  const period = periods[g.asset];
                  return (
                    <tbody key={g.asset} className={expanded ? "is-expanded" : ""}>
                      {g.positions.map((v, index) => {
                        const short = D(v.positionAmt).lt(0);
                        const liq =
                          v.liquidationPrice && D(v.liquidationPrice).gt(0)
                            ? v.liquidationPrice
                            : null;
                        const distance =
                          liq && D(v.markPrice).gt(0)
                            ? D(liq)
                                .minus(v.markPrice)
                                .mul(short ? 1 : -1)
                                .div(v.markPrice)
                                .mul(100)
                                .toString()
                            : null;
                        const unit = v.contractMarket === "coin" ? "USD" : "USDT";
                        return (
                          <tr key={v.symbol + ":" + v.positionSide} className="hedge-position-row">
                            {index === 0 && (
                              <td rowSpan={g.positions.length} className="hedge-comparison-asset">
                                <button
                                  className="futures-asset-button"
                                  aria-label={`${g.asset} 对冲明细`}
                                  aria-expanded={expanded}
                                  onClick={() =>
                                    setExpandedAssets((prev) =>
                                      expanded
                                        ? prev.filter((a) => a !== g.asset)
                                        : [...prev, g.asset],
                                    )
                                  }
                                >
                                  <CoinIcon asset={g.asset} />
                                  <span>
                                    <strong>{g.asset}</strong>
                                    <HedgeStatus group={g} />
                                  </span>
                                  {expanded ? (
                                    <ChevronDown size={15} />
                                  ) : (
                                    <ChevronRight size={15} />
                                  )}
                                </button>
                              </td>
                            )}
                            <td className="hedge-contract-cell">
                              <div>
                                <span className={`futures-direction ${short ? "short" : "long"}`}>
                                  {short ? "空" : "多"}
                                </span>
                                <strong>{contractLabel(v)}</strong>
                              </div>
                              <small>{v.symbol}</small>
                              <small>
                                {v.contractMarket === "coin"
                                  ? `${n(D(v.contracts!).abs().toString(), 0)} 张 · `
                                  : ""}
                                {n(D(v.positionAmt).abs().toString(), 6)} {g.asset}
                              </small>
                            </td>
                            <td>
                              {p(v.entryPrice)}
                              <small>{unit}</small>
                            </td>
                            <td>
                              {p(v.markPrice)}
                              <small>{unit}</small>
                            </td>
                            <td>
                              {p(liq)}
                              <small>
                                {distance !== null
                                  ? `距离 ${n(distance)}${hidden ? "" : "%"}`
                                  : "—"}
                              </small>
                            </td>
                            <td>
                              <strong className={tone(v.unRealizedProfit)}>
                                {n(v.unRealizedProfit, 2, true)}
                              </strong>
                              <small>
                                {v.marginType === "isolated"
                                  ? "逐仓"
                                  : v.marginType === "cross"
                                    ? "全仓"
                                    : "—"}
                              </small>
                            </td>
                            {index === 0 && (
                              <>
                                <td
                                  rowSpan={g.positions.length}
                                  className="hedge-combination-value"
                                >
                                  <strong className={tone(g.holdingPnl)}>
                                    {n(g.holdingPnl, 2, true)}
                                  </strong>
                                  <small>{g.pnlComplete ? "含资金费" : "暂计"}</small>
                                </td>
                                <td rowSpan={g.positions.length}>
                                  <strong>
                                    {n(g.hedgeRatio)}
                                    {hidden || g.hedgeRatio === null ? "" : "%"}
                                  </strong>
                                  <small>净敞口 {n(g.netExposure, 2, true)}</small>
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                      {expanded && (
                        <tr className="hedge-comparison-detail-row">
                          <td colSpan={8}>
                            <div className="hedge-detail hedge-inline-detail">
                              <div className="overview-panel-heading">
                                <div>
                                  <span className="overview-kicker">HEDGE ATTRIBUTION</span>
                                  <h2>{g.asset} 对冲明细</h2>
                                </div>
                                <div className="hedge-start">
                                  <span>开始记录</span>
                                  <strong>
                                    {period
                                      ? new Date(period.startedAt).toLocaleString("zh-CN", {
                                          hour12: false,
                                        })
                                      : "等待完整数据"}
                                  </strong>
                                </div>
                              </div>
                              <PositionLegs group={g} hidden={hidden} />
                              <div className="hedge-section">
                                <h3>对冲期间损益</h3>
                                <div className="hedge-attribution">
                                  {[
                                    ["现货 / 保证金币损益", period?.spotPnl],
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
                                <FuturesRisk positions={g.positions} hidden={hidden} />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  );
                })}
              </table>
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
