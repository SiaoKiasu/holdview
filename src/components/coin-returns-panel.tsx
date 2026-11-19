"use client";

import Decimal from "decimal.js";
import { buildCoinReturns } from "@/lib/coin-returns";
import type { Dashboard } from "@/lib/types";
import { CoinIcon } from "./coin-icon";

export function CoinReturnsPanel({
  data,
  hidden,
}: {
  data: Pick<Dashboard, "coinInventory" | "coinWallets">;
  hidden: boolean;
}) {
  const result = buildCoinReturns(data.coinInventory, data.coinWallets);
  if (!result.rows.length) return null;
  const number = (value: string | null, digits: number) => {
    if (hidden) return "••••";
    if (value == null) return "—";
    const d = new Decimal(value);
    return (
      (d.isZero() ? "" : d.isNegative() ? "−" : "+") +
      d
        .abs()
        .toNumber()
        .toLocaleString("en-US", {
          minimumFractionDigits: digits === 2 ? 2 : 0,
          maximumFractionDigits: digits,
        })
    );
  };
  const tone = (value: string | null) =>
    hidden || value == null || new Decimal(value).isZero()
      ? ""
      : new Decimal(value).isNegative()
        ? "negative"
        : "positive";
  return (
    <section className="panel coin-returns-panel" aria-label="币本位收益">
      <div className="coin-returns-heading">
        <div className="coin-returns-title">
          <h2>币本位收益</h2>
          <span
            title={
              result.complete
                ? "累计已同步的币本位结算流水"
                : "历史流水或钱包核对未完成，下列金额为已同步部分。"
            }
          >
            {result.complete ? "累计结算" : "暂计 · 待核对"}
          </span>
        </div>
        <div className="coin-returns-totals">
          <div title="币本位合约平仓收益 + 已发生交易手续费 + 手续费返还；不含资金费、现货收益和币支付价差。">
            <span>
              已实现盈亏 <small>USDT</small>
            </span>
            <strong className={tone(result.realizedValue)}>
              {number(result.realizedValue, 2)}
            </strong>
          </div>
          <div title="币本位累计资金费净收入，沿用账户口径计入持仓盈亏，不重复计入已实现盈亏。">
            <span>
              资金费净收益 <small>USDT</small>
            </span>
            <strong className={tone(result.fundingValue)}>{number(result.fundingValue, 2)}</strong>
          </div>
        </div>
      </div>
      <div className="table-scroll">
        <table className="coin-returns-table">
          <thead>
            <tr>
              <th>结算币种</th>
              <th>
                平仓收益 <small>币</small>
              </th>
              <th title="已发生的买卖手续费 + 手续费返还，扣费为负、返还为正。">
                手续费净额 <small>币</small>
              </th>
              <th>
                资金费 <small>币</small>
              </th>
              <th
                className="coin-returns-net"
                title="平仓收益 + 手续费净额 + 资金费；不含划转和未结算浮盈亏。"
              >
                已结算净增币
              </th>
              <th title="本币种的合约平仓收益扣除交易费用，按各笔发生时的价格折算。">
                已实现盈亏 <small>USDT</small>
              </th>
              <th>
                未结算浮盈亏 <small>币</small>
              </th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.asset}>
                <th scope="row">
                  <div className="coin-returns-asset">
                    <CoinIcon asset={r.asset} compact />
                    <strong>{r.asset}</strong>
                  </div>
                </th>
                <td className={tone(r.realizedCoin)}>{number(r.realizedCoin, 8)}</td>
                <td className={tone(r.feeCoin)}>{number(r.feeCoin, 8)}</td>
                <td className={tone(r.fundingCoin)}>{number(r.fundingCoin, 8)}</td>
                <td className={`coin-returns-net ${tone(r.netCoin)}`}>
                  <strong>{number(r.netCoin, 8)}</strong>
                </td>
                <td className={tone(r.realizedValue)}>{number(r.realizedValue, 2)}</td>
                <td className={tone(r.unrealizedCoin)}>{number(r.unrealizedCoin, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="coin-returns-note">净增币不含划转与浮盈亏；USDT 按每笔流水发生时折算。</p>
    </section>
  );
}
