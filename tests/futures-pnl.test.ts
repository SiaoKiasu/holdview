import { describe, expect, it } from "vitest";
import { futuresAccounting } from "@/lib/futures-pnl";
import type { FuturesData, FuturesIncome } from "@/lib/types";
function income(
  tranId: string,
  incomeType: string,
  amount: string,
  symbol = "NEWUSDT",
): FuturesIncome {
  return { tranId, incomeType, income: amount, symbol, asset: "USDT", time: 60000 };
}
function data(): FuturesData {
  return {
    positions: [
      {
        symbol: "NEWUSDT",
        positionSide: "BOTH",
        positionAmt: "2",
        entryPrice: "50",
        markPrice: "55",
        unRealizedProfit: "10",
        marginAsset: "USDT",
      },
    ],
    ledger: {
      startTime: 0,
      syncedThrough: 1,
      feeRates: {},
      incomes: [
        income("1", "TRANSFER", "150"),
        income("2", "COMMISSION", "-1"),
        income("3", "FUNDING_FEE", "2"),
      ],
    },
    complete: true,
    warnings: [],
  };
}
describe("contract PnL separated from transfer valuation", () => {
  it("charges trading fees to realized and signed funding to holdings without adding transfers", () => {
    const d = data();
    d.ledger.incomes.push(income("4", "REALIZED_PNL", "5"), income("5", "FUNDING_FEE", "-0.5"));
    expect(futuresAccounting(d)).toMatchObject({
      realizedPnl: "4",
      feePnl: "-1",
      holdingPnl: "11.5",
      fundingPnl: "1.5",
      complete: true,
    });
    expect(futuresAccounting(d).holdings[0]).toMatchObject({
      averageCost: "50",
      price: "55",
      quantity: "2",
      value: "110",
      unrealizedPnl: "11.5",
      returnRate: "11.5",
    });
  });
  it("uses exchange PnL for shorts and allocates symbol funding once across hedge sides", () => {
    const d = data();
    d.positions[0] = {
      ...d.positions[0],
      positionAmt: "-2",
      positionSide: "SHORT",
      unRealizedProfit: "-10",
    };
    expect(futuresAccounting(d).holdings[0]).toMatchObject({
      direction: "空",
      unrealizedPnl: "-8",
      returnRate: "-8",
    });
    d.positions.push({
      ...d.positions[0],
      positionAmt: "2",
      positionSide: "LONG",
      unRealizedProfit: "10",
    });
    const result = futuresAccounting(d);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      direction: "双向",
      unrealizedPnl: "2",
      quantity: "4",
      returnRate: "1",
    });
    expect(result.holdingPnl).toBe("2");
  });
  it("retains funding after closing a position and does not double-count repeated events", () => {
    const d = data();
    d.positions = [];
    d.ledger.incomes.push(d.ledger.incomes[2]);
    expect(futuresAccounting(d)).toMatchObject({
      fundingPnl: "2",
      holdingPnl: "2",
      realizedPnl: "-1",
    });
    expect(futuresAccounting(d).holdings[0]).toMatchObject({
      direction: "已平仓",
      value: "0",
      unrealizedPnl: "2",
      returnRate: null,
    });
  });
  it("does not fabricate PnL with missing data or non-USDT margin", () => {
    expect(futuresAccounting(undefined).realizedPnl).toBeNull();
    const d = data();
    d.complete = false;
    d.ledger.incomes = [];
    expect(futuresAccounting(d)).toMatchObject({
      realizedPnl: null,
      holdingPnl: null,
      complete: false,
    });
    d.complete = true;
    d.positions[0].marginAsset = "USDC";
    expect(futuresAccounting(d)).toMatchObject({
      realizedPnl: null,
      holdingPnl: null,
      complete: false,
    });
  });
  it("keeps missing third-token fee rates unknown and converts at historical rates when present", () => {
    const d = data();
    d.ledger.incomes[1].asset = "BNB";
    d.ledger.incomes[1].income = "-0.01";
    expect(futuresAccounting(d)).toMatchObject({
      realizedPnl: null,
      holdingPnl: "12",
      complete: false,
    });
    d.ledger.feeRates["BNB:60000"] = "500";
    expect(futuresAccounting(d)).toMatchObject({
      realizedPnl: "-5",
      holdingPnl: "12",
      complete: true,
    });
  });
});
