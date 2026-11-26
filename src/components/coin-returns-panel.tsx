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
  const number = (value: string | null, digits: number, signed = true) => {
    if (hidden) return "••••";
    if (value == null) return "—";
    const d = new Decimal(value);
    return (
      (d.isNegative() ? "−" : !signed || d.isZero() ? "" : "+") +
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
    <section className="panel coin-returns-panel" aria-label="对冲结算">
      <div className="coin-returns-heading">
        <div className="coin-returns-title">
          <h2>对冲结算</h2>
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
              <th title="当前币数减累计已结算净增币；现货与保证金币合并计算，随买卖及外部转入转出调整，并非首次开仓时的固定币数。">
                初始币数
              </th>
              <th title="现货与币本位钱包的已结算持币数量，不含合约浮盈亏。">当前币数</th>
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
              <th title="币本位合约未结算浮盈亏按当前币价折算，不含持币本身的币价涨跌。">
                未实现盈亏 <small>USDT</small>
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
                <td>{number(r.initialCoin, 8, false)}</td>
                <td>{number(r.currentCoin, 8, false)}</td>
                <td className={`coin-returns-net ${tone(r.netCoin)}`}>
                  <strong>{number(r.netCoin, 8)}</strong>
                </td>
                <td className={tone(r.realizedValue)}>{number(r.realizedValue, 2)}</td>
                <td className={tone(r.unrealizedCoin)}>{number(r.unrealizedCoin, 8)}</td>
                <td className={tone(r.unrealizedValue)}>{number(r.unrealizedValue, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="coin-returns-note">
        初始币数按净投入调整；已实现盈亏按结算时币价折算，未实现盈亏按当前币价折算。
        {!result.complete && " 历史流水待核对，部分数据暂计。"}
      </p>
    </section>
  );
}
