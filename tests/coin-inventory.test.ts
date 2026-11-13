import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { coinInventory } from "@/lib/coin-inventory";
import { futuresAccounting } from "@/lib/futures-pnl";
import { physicalHoldings } from "@/lib/physical-holdings";
import { liveValuation } from "@/lib/live-valuation";
import type { ProviderData, Trade, FuturesIncome, Dashboard } from "@/lib/types";
const trade = (patch: Partial<Trade> = {}): Trade => ({
  id: "1",
  symbol: "BTCUSDT",
  side: "BUY",
  price: "80000",
  quantity: "0.1",
  quoteQuantity: "8000",
  fee: "0",
  feeAsset: "USDT",
  time: 60000,
  isMaker: false,
  ...patch,
});
function fixture(): ProviderData {
  const ledger = {
    startTime: 0,
    syncedThrough: 600000,
    feeRates: { "BTC:180000": "70000", "BTC:240000": "70000" },
    incomes: [] as FuturesIncome[],
    transfers: {
      complete: true,
      directions: {},
      rows: [
        {
          tranId: "1",
          asset: "BTC",
          amount: "0.1",
          type: "MAIN_CMFUTURE" as const,
          status: "CONFIRMED",
          timestamp: 120000,
        },
      ],
    },
  };
  return {
    balances: [],
    tickers: [{ symbol: "BTCUSDT", lastPrice: "70000", priceChangePercent: "0" }],
    trades: [],
    orders: [],
    warnings: [],
    tradesComplete: true,
    ordersComplete: true,
    ledger: {
      version: 1,
      markets: {
        BTCUSDT: {
          baseAsset: "BTC",
          quoteAsset: "USDT",
          nextId: "2",
          complete: true,
          checkedAt: 600000,
          trades: [trade()],
        },
      },
      coinFutures: ledger,
    },
    futures: {
      account: {
        equity: "7000",
        walletBalance: "7000",
        availableBalance: "0",
        initialMargin: "7000",
      },
      coinWallets: [
        {
          asset: "BTC",
          walletBalance: "0.1",
          marginBalance: "0.1",
          unrealizedProfit: "0",
          availableBalance: "0",
          initialMargin: "0.1",
          price: "70000",
        },
      ],
      positions: [],
      positionsComplete: true,
      orders: [],
      ordersComplete: true,
      trades: [],
      tradesComplete: true,
      ledger,
      complete: true,
      warnings: [],
    },
  };
}
function addIncome(d: ProviderData, type: string, amount: string, time = 180000) {
  d.ledger!.coinFutures!.incomes.push({
    contractMarket: "coin",
    tranId: String(d.ledger!.coinFutures!.incomes.length + 1),
    symbol: "BTCUSD_PERP",
    incomeType: type,
    income: amount,
    asset: "BTC",
    time,
  });
  const w = d.futures!.coinWallets![0];
  w.walletBalance = new Decimal(w.walletBalance).plus(amount).toString();
  w.marginBalance = w.walletBalance;
}
const near = (actual: string | null, expected: number) =>
  expect(Number(actual)).toBeCloseTo(expected, 8);
describe("coin asset accounting", () => {
  it("preserves acquisition cost on wallet transfers and includes collateral in physical holdings", () => {
    const d = fixture(),
      b = coinInventory(d);
    expect(b.assets.BTC).toMatchObject({
      quantity: "0.1",
      averageCost: "80000",
      cost: "8000",
      complete: true,
    });
    expect(b.accounting.realizedPnl).toBe("0");
    d.balances = [{ asset: "BTC", free: "0.04", locked: "0" }];
    d.futures!.coinWallets![0].walletBalance = "0.06";
    d.ledger!.coinFutures!.transfers!.rows.push({
      tranId: "2",
      asset: "BTC",
      amount: "0.04",
      type: "CMFUTURE_MAIN",
      status: "CONFIRMED",
      timestamp: 240000,
    });
    expect(coinInventory(d).assets.BTC).toMatchObject({
      averageCost: "80000",
      cost: "8000",
      complete: true,
    });
  });
  it("books newly earned coins at settlement FX, without applying the original 80000 basis to them", () => {
    const d = fixture();
    addIncome(d, "FUNDING_FEE", "0.001");
    const b = coinInventory(d).assets.BTC;
    expect(b).toMatchObject({
      quantity: "0.101",
      cost: "8070",
      fundingCoin: "0.001",
      fundingValue: "70",
      complete: true,
    });
    near(new Decimal(b.quantity).mul(70000).minus(b.cost!).toString(), -1000);
    // At 72000, the newly earned coin adds only $2 price PnL; funding remains $70.
    near(new Decimal(b.quantity).mul(72000).minus(b.cost!).toString(), -798);
  });
  it("records coin fee expense once and realizes the disposed coin's FX separately", () => {
    const d = fixture();
    addIncome(d, "COMMISSION", "-0.001");
    const b = coinInventory(d),
      f = futuresAccounting(d.futures);
    expect(b.assets.BTC).toMatchObject({
      quantity: "0.099",
      cost: "7920",
      disposalPnl: "-10",
      commissionValue: "-70",
      complete: true,
    });
    expect(b.accounting.realizedPnl).toBe("-10");
    expect(f.realizedPnl).toBe("-70");
    // 6930 current equity - 8000 initial spend = -1070 = -80 realized -990 inventory.
    near(
      new Decimal(b.accounting.realizedPnl!)
        .plus(f.realizedPnl!)
        .plus(new Decimal("0.099").mul(70000).minus(b.assets.BTC.cost!))
        .toString(),
      -1070,
    );
  });
  it("handles partial close, mixed funding and fees without creating unrealized coins as holdings", () => {
    const d = fixture();
    addIncome(d, "REALIZED_PNL", "0.002");
    addIncome(d, "FUNDING_FEE", "-0.0001", 240000);
    addIncome(d, "COMMISSION", "-0.00002", 240000);
    d.futures!.coinWallets![0].unrealizedProfit = "0.003";
    d.futures!.coinWallets![0].marginBalance = "0.10488";
    const b = coinInventory(d),
      a = b.assets.BTC,
      f = futuresAccounting(d.futures);
    expect(a.complete).toBe(true);
    expect(a.quantity).toBe("0.10188");
    const inventory = new Decimal(a.quantity).mul(70000).minus(a.cost!);
    const total = inventory
      .plus(b.accounting.realizedPnl!)
      .plus(f.realizedPnl!)
      .plus(f.fundingPnl!);
    near(total.toString(), new Decimal("0.10188").mul(70000).minus(8000).toNumber());
  });
  it("deduplicates incomes and trades, including 64-bit IDs", () => {
    const d = fixture();
    addIncome(d, "REALIZED_PNL", "0.002");
    d.ledger!.coinFutures!.incomes.push({ ...d.ledger!.coinFutures!.incomes[0] });
    d.ledger!.markets.BTCUSDT.trades.push(trade());
    expect(coinInventory(d).assets.BTC).toMatchObject({
      quantity: "0.102",
      cost: "8140",
      complete: true,
    });
  });
  it.each(["missingRate", "missingTransfer", "unexpectedDeposit", "incomplete", "unknownIncome"])(
    "withholds a fabricated cost when %s",
    (kind) => {
      const d = fixture();
      addIncome(d, "REALIZED_PNL", "0.002");
      if (kind === "missingRate") d.ledger!.coinFutures!.feeRates = {};
      if (kind === "missingTransfer") d.ledger!.coinFutures!.transfers!.rows = [];
      if (kind === "unexpectedDeposit") d.futures!.coinWallets![0].walletBalance = "0.103";
      if (kind === "incomplete") d.tradesComplete = false;
      if (kind === "unknownIncome") addIncome(d, "UNKNOWN", "0.001");
      const b = coinInventory(d);
      expect(b.assets.BTC.complete).toBe(false);
      expect(b.assets.BTC.averageCost).toBeNull();
      expect(b.accounting.realizedPnl).toBeNull();
    },
  );
  it("carries settlement basis back to spot and sells it at the pooled average", () => {
    const d = fixture();
    addIncome(d, "REALIZED_PNL", "0.002");
    d.ledger!.coinFutures!.transfers!.rows.push({
      tranId: "2",
      asset: "BTC",
      amount: "0.102",
      type: "CMFUTURE_MAIN",
      status: "CONFIRMED",
      timestamp: 240000,
    });
    d.futures!.coinWallets![0].walletBalance = "0";
    d.futures!.coinWallets![0].marginBalance = "0";
    d.ledger!.markets.BTCUSDT.trades.push(
      trade({
        id: "2",
        side: "SELL",
        price: "90000",
        quantity: "0.102",
        quoteQuantity: "9180",
        fee: "9.18",
        time: 300000,
      }),
    );
    const b = coinInventory(d);
    expect(b.assets.BTC).toMatchObject({ quantity: "0", cost: "0", complete: true });
    near(
      new Decimal(b.accounting.realizedPnl!)
        .plus(futuresAccounting(d.futures).realizedPnl!)
        .toString(),
      1170.82,
    );
  });
  it("includes only actual coin balance in spot view and never mutates equity or exposure inputs", () => {
    const d = fixture();
    addIncome(d, "FUNDING_FEE", "0.001");
    const b = coinInventory(d);
    const w = {
      ...d.futures!.coinWallets![0],
      averageCost: b.assets.BTC.averageCost,
      holdingPnl: "-1000",
      unrealizedProfit: "0.01",
      marginBalance: "0.111",
    };
    const dash = {
      source: "binance",
      environment: "Binance Spot",
      updatedAt: 600000,
      holdings: [],
      coinWallets: [w],
      coinInventory: b.assets,
      positionDetails: [],
      summary: { equity: "7770", futuresEquity: "7770", unrealizedPnl: "-230", realizedPnl: "0" },
    } as unknown as Dashboard;
    const before = structuredClone(dash);
    const rows = physicalHoldings(dash);
    expect(rows[0]).toMatchObject({
      quantity: "0.101",
      walletQuantity: "0.101",
      spotQuantity: "0",
      value: "7070",
      unrealizedPnl: "-1000",
    });
    expect(dash).toEqual(before);
    const next = liveValuation(
      dash,
      {
        environment: "mainnet",
        spot: { time: 601000, prices: { BTCUSDT: "72000" } },
        futures: null,
      },
      601010,
    );
    expect(physicalHoldings(next)[0].unrealizedPnl).toBe("-798");
    expect(next.coinInventory).toEqual(b.assets);
  });
});

import { closedReview } from "@/lib/closed-review";
import { projectPlan, planKey } from "@/lib/trade-plan";
it("uses the same settlement-adjusted basis in spot closing analysis", () => {
  const d = fixture();
  addIncome(d, "REALIZED_PNL", "0.002");
  d.ledger!.coinFutures!.transfers!.rows.push({
    tranId: "2",
    asset: "BTC",
    amount: "0.051",
    type: "CMFUTURE_MAIN",
    status: "CONFIRMED",
    timestamp: 240000,
  });
  d.futures!.coinWallets![0].walletBalance = "0.051";
  d.ledger!.markets.BTCUSDT.trades.push(
    trade({
      id: "2",
      side: "SELL",
      price: "90000",
      quantity: "0.051",
      quoteQuantity: "4590",
      time: 300000,
    }),
  );
  const b = coinInventory(d);
  expect(b.assets.BTC.complete).toBe(true);
  const row = closedReview(d, [{ asset: "BTC", value: "3570" } as any], b.assets).rows[0];
  expect(row).toMatchObject({
    status: "partial",
    cost: "4070",
    grossPnl: "520",
    netPnl: "520",
    complete: true,
  });
});
it("projects a shared coin basis but never treats collateral as sellable spot", () => {
  const d = fixture(),
    b = coinInventory(d);
  const dash = {
    holdings: [],
    coinWallets: [
      { ...d.futures!.coinWallets![0], averageCost: b.assets.BTC.averageCost, holdingPnl: "-1000" },
    ],
    summary: {
      equity: "10000",
      equityComplete: true,
      cash: "3000",
      cashFree: "3000",
      cashLocked: "0",
    },
    connection: {},
  } as any;
  const order = {
    id: "x",
    symbol: "BTCUSDT",
    side: "BUY",
    type: "LIMIT",
    price: "70000",
    quantity: "0.01",
    executedQuantity: "0",
    status: "NEW",
    time: 1,
  } as any;
  const choices = { [planKey(order)]: { enabled: true, percent: "100" } };
  const plan = projectPlan(dash, [order], choices);
  expect(plan.errors).toEqual([]);
  const sell = { ...order, side: "SELL" };
  expect(projectPlan(dash, [sell], choices).errors.join(" ")).toContain("保证金币未划回现货");
});
