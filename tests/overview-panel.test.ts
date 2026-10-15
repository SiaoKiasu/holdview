import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewPanel } from "@/components/overview-panel";
import type { Dashboard, Holding } from "@/lib/types";

const holding = (extra: Partial<Holding>): Holding => ({
  asset: "BTC",
  quantity: "1",
  free: "1",
  locked: "0",
  price: "100",
  value: "100",
  allocation: 10,
  change24h: null,
  averageCost: "80",
  unrealizedPnl: "20",
  ...extra,
});
const fixture = (): Dashboard => ({
  accountLabel: "Test",
  source: "demo",
  environment: "test",
  updatedAt: Date.now(),
  warnings: [],
  closedReview: { rows: [], complete: true },
  holdings: [
    holding({}),
    holding({ asset: "USDT", value: "750", unrealizedPnl: "0" }),
    holding({
      asset: "PONS",
      instrument: "futures",
      value: "1500",
      unrealizedPnl: "-15",
      returnRate: "-10",
    }),
    holding({ asset: "DUST", value: "0.2", unrealizedPnl: "0.1" }),
  ],
  history: [],
  trades: [],
  orders: [],
  summary: {
    equity: "1000.2",
    pricedAssets: 4,
    unpricedAssets: 0,
    costCoverage: 4,
    totalPnl: null,
    feePnl: "0",
    realizedPnlNote: "",
    cash: "750",
    baseline: null,
    baselineAt: null,
    netFlows: null,
    stablecoinValue: "750",
    tradeCount: 0,
    equityComplete: true,
    equitySource: "exchange",
    futuresEquity: "150",
    realizedPnl: "12",
    realizedPnlComplete: true,
    unrealizedPnl: "5.1",
    principal: "1000",
    cashFree: "700",
    cashLocked: "50",
  },
  connection: {
    futuresEnabled: true,
    ordersComplete: true,
    tradesComplete: true,
    historySync: { scanned: 0, total: 0, oldestCheck: null },
    database: false,
    snapshotsSaved: false,
    symbols: [],
  },
});
const render = (data: Dashboard, hidden = false) =>
  renderToStaticMarkup(
    createElement(OverviewPanel, {
      data,
      hidden,
      period: 7,
      onPeriod: () => {},
      onNavigate: () => {},
      chart: null,
    }),
  );
describe("overview financial presentation", () => {
  it("uses futures equity rather than notional exposure in allocation", () => {
    const html = render(fixture());
    expect(html).toMatch(/合约权益<\/span><strong>150.00<\/strong><small>15.0%/);
    expect(html).not.toContain("1,500.00");
    expect(html).toContain("1,000.20");
    expect(html).not.toContain(">DUST<");
  });
  it("does not turn missing income, cash-flow history, or equity into zero", () => {
    const data = fixture();
    data.summary.realizedPnl = null;
    data.summary.unrealizedPnl = null;
    data.summary.futuresEquity = null;
    data.summary.equityComplete = false;
    const html = render(data);
    expect(html).toContain("已估值资产小计");
    expect(html).toMatch(/合约权益<\/span><strong>—<\/strong><small>—/);
    expect(html).toContain("成本或行情待补齐");
    expect(html).toMatch(/已实现盈亏 <\/span><strong class="">—/);
    expect(html).toMatch(/持仓盈亏 <\/span><strong class="">—/);
  });
  it("hides values and allocation ratios in privacy mode", () => {
    const html = render(fixture(), true);
    for (const value of ["1,000.20", "750.00", "150.00", "15.0%", "+20.00", "−15.00", "+25.00%"])
      expect(html).not.toContain(value);
    expect(html).toContain("••••");
    expect(html).not.toContain("overview-pnl-track");
  });
  it("shows the four latest trades in descending order without mutating the source", () => {
    const data = fixture();
    data.trades = [1, 5, 2, 4, 3].map((n) => ({
      id: String(n),
      symbol: "ASSET" + n + "USDT",
      side: "BUY",
      price: "1",
      quantity: "2",
      quoteQuantity: "2",
      fee: "0",
      feeAsset: "USDT",
      time: n * 1000,
      isMaker: true,
    }));
    const before = structuredClone(data);
    const html = render(data);
    expect(html).not.toContain("ASSET1USDT");
    expect(html.indexOf("ASSET5USDT")).toBeLessThan(html.indexOf("ASSET4USDT"));
    expect(html.indexOf("ASSET4USDT")).toBeLessThan(html.indexOf("ASSET3USDT"));
    expect(html.indexOf("ASSET3USDT")).toBeLessThan(html.indexOf("ASSET2USDT"));
    expect(html).not.toContain("区间资产变化");
    expect(data).toEqual(before);
  });
});
