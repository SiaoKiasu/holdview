import { describe, it, expect, vi } from "vitest";
import Decimal from "decimal.js";
import { BinanceCoinFuturesClient } from "@/lib/binance-coin-futures";
import { mergeFutures } from "@/lib/futures-merge";
import { futuresAccounting } from "@/lib/futures-pnl";
import { buildExposure } from "@/lib/exposure";
import { liveValuation } from "@/lib/live-valuation";
import { trackHedges } from "@/lib/hedge-tracking";
import { closedReview } from "@/lib/closed-review";
import { demoData } from "@/lib/demo";
import type { FuturesData, FuturesLedger, Dashboard, ProviderData, Trade } from "@/lib/types";
const config = {
  BINANCE_ENV: "mainnet" as const,
  BINANCE_API_KEY: "test-read-key",
  BINANCE_API_SECRET: "test-secret",
};
const now = Date.now(),
  eventTime = now - 1000;
const coinIncome = (incomeType: string, income: string) => ({
  tranId: "1",
  symbol: "BTCUSD_PERP",
  incomeType,
  income,
  asset: "BTC",
  time: eventTime,
  tradeId: "1",
});
const contract = {
  symbol: "BTCUSD_PERP",
  baseAsset: "BTC",
  marginAsset: "BTC",
  quoteAsset: "USD",
  contractSize: 100,
  contractType: "PERPETUAL",
};
function transport(override?: (u: URL) => unknown) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    expect(init?.method).toBe("GET");
    const privatePath =
      /\/(account|positionRisk|income|userTrades|openOrders|openAlgoOrders)$/.test(u.pathname);
    if (privatePath) {
      expect(u.searchParams.has("signature")).toBe(true);
      expect((init?.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe("test-read-key");
    } else expect((init?.headers as Record<string, string>)["X-MBX-APIKEY"]).toBeUndefined();
    const custom = override?.(u);
    if (custom !== undefined) return Response.json(custom);
    let result: unknown;
    switch (u.pathname) {
      case "/dapi/v1/time":
        result = { serverTime: Date.now() };
        break;
      case "/dapi/v1/exchangeInfo":
        result = { symbols: [contract] };
        break;
      case "/api/v3/ticker/price":
        result = [{ symbol: "BTCUSDT", price: "50000" }];
        break;
      case "/dapi/v1/account":
        result = {
          assets: [
            {
              asset: "BTC",
              walletBalance: "0.1",
              marginBalance: "0.1",
              unrealizedProfit: "0",
              availableBalance: "0.08",
              initialMargin: "0.02",
            },
          ],
          positions: [
            {
              symbol: contract.symbol,
              positionSide: "SHORT",
              initialMargin: "0.02",
              maintMargin: "0.001",
              isolated: false,
            },
          ],
        };
        break;
      case "/dapi/v1/positionRisk":
        result = [
          {
            symbol: contract.symbol,
            positionSide: "SHORT",
            positionAmt: "-100",
            entryPrice: "50000",
            markPrice: "50000",
            unRealizedProfit: "0",
            marginType: "cross",
            liquidationPrice: "90000",
          },
        ];
        break;
      case "/dapi/v1/income":
        result = [coinIncome("COMMISSION", "-0.00001"), coinIncome("FUNDING_FEE", "0.00002")];
        break;
      case "/dapi/v1/userTrades":
        result = [
          {
            id: 1,
            symbol: contract.symbol,
            side: "SELL",
            price: "50000",
            qty: "100",
            baseQty: "0.2",
            commission: "0.00001",
            commissionAsset: "BTC",
            realizedPnl: "0",
            time: eventTime,
            maker: true,
            positionSide: "SHORT",
          },
        ];
        break;
      case "/api/v3/klines":
        result = [[Number(u.searchParams.get("startTime")), "0", "0", "0", "50000"]];
        break;
      case "/dapi/v1/openOrders":
      case "/dapi/v1/openAlgoOrders":
        result = [];
        break;
      default:
        throw Error("Unexpected test path: " + u.pathname);
    }
    return Response.json(result);
  }) as unknown as typeof fetch;
}
const empty = (): FuturesData => ({
  account: { equity: "0", walletBalance: "0", availableBalance: "0", initialMargin: "0" },
  positions: [],
  positionsComplete: true,
  orders: [],
  ordersComplete: true,
  trades: [],
  tradesComplete: true,
  ledger: { startTime: now - 10000, syncedThrough: now, feeRates: {}, incomes: [] },
  complete: true,
  warnings: [],
});
async function fixture() {
  return new BinanceCoinFuturesClient(config, transport()).loadFutures();
}
function dashboard(cm: FuturesData): Dashboard {
  const d = demoData(),
    f = futuresAccounting(cm);
  return {
    source: "binance",
    accountLabel: "test",
    environment: "Binance Spot",
    updatedAt: now,
    holdings: [
      {
        asset: "BTC",
        free: "0.1",
        locked: "0",
        quantity: "0.1",
        price: "50000",
        value: "5000",
        averageCost: "40000",
        unrealizedPnl: "1000",
        allocation: 50,
        change24h: null,
      },
      ...f.holdings,
    ],
    coinWallets: cm.coinWallets!.map((w) => ({ ...w, averageCost: "40000", holdingPnl: "1000" })),
    positionDetails: cm.positions,
    trades: cm.trades!,
    orders: [],
    history: [],
    hedgePeriods: {},
    warnings: [],
    closedReview: { rows: [], complete: true },
    summary: {
      equity: "10000",
      futuresEquity: "5000",
      equityComplete: true,
      unrealizedPnl: "2001",
      realizedPnl: "-0.5",
      feePnl: "-0.5",
      cash: "0",
      totalPnl: null,
    } as Dashboard["summary"],
    connection: { futuresEnabled: true, futuresPositionsComplete: true } as Dashboard["connection"],
  };
}
describe("COIN-M integration", () => {
  it("preserves adjacent 64-bit CM income IDs and numeric trade IDs without rounding or dropping history", async () => {
    const fallback = transport();
    const wire: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/dapi/v1/income") {
        return new Response(
          '[{"tranId":9007199254740992,"tradeId":9007199254740994,"symbol":"BTCUSD_PERP","incomeType":"COMMISSION","income":"-0.00001","asset":"BTC","time":' +
            eventTime +
            '},{"tranId":9007199254740993,"tradeId":9007199254740995,"symbol":"BTCUSD_PERP","incomeType":"COMMISSION","income":"-0.00002","asset":"BTC","time":' +
            eventTime +
            "}]",
        );
      }
      return fallback(input, init);
    };
    const cm = await new BinanceCoinFuturesClient(config, wire).loadFutures();
    expect(cm.complete).toBe(true);
    expect(cm.ledger.incomes.map((i) => i.tranId)).toEqual([
      "9007199254740992",
      "9007199254740993",
    ]);
    expect(cm.ledger.incomes.map((i) => i.tradeId)).toEqual([
      "9007199254740994",
      "9007199254740995",
    ]);
    expect(futuresAccounting(cm).feePnl).toBe("-1.5");
    expect(cm.warnings.some((w) => w.includes("流水读取失败"))).toBe(false);
  });
  it("recognizes a coin-wallet-only long hedged by a COIN-M short after spot was transferred out", async () => {
    const cm = await fixture();
    const d = dashboard(cm);
    d.holdings = d.holdings.filter((h) => h.instrument === "futures");
    const e = buildExposure(d);
    const btc = e.groups.find((g) => g.asset === "BTC")!;
    expect(e.complete).toBe(true);
    expect(e.unsupported).toEqual([]);
    expect(btc.hedged).toBe(true);
    expect(btc.shortQuantity).toBe("0.2");
    expect(btc.collateralQuantity).toBe("0.1");
    expect(btc.hedgeRatio).toBe("200");
    expect(btc.netExposure).toBe("-5000");
  });

  it("reads only GETs, derives coin quantities from exchange face size, preserves native units and accounts once", async () => {
    const cm = await fixture();
    expect(cm.account).toEqual({
      equity: "5000",
      walletBalance: "5000",
      availableBalance: "4000",
      initialMargin: "1000",
    });
    expect(cm.positions[0]).toMatchObject({
      contractMarket: "coin",
      contracts: "-100",
      contractSize: "100",
      positionAmt: "-0.2",
      unRealizedProfit: "0",
      nativeUnrealizedPnl: "0",
      initialMargin: "1000",
      marginAsset: "BTC",
      baseAsset: "BTC",
    });
    expect(cm.trades![0]).toMatchObject({
      quantity: "100",
      quoteQuantity: "10000",
      realizedPnlAsset: "BTC",
    });
    const f = futuresAccounting(cm);
    expect(f).toMatchObject({
      realizedPnl: "-0.5",
      feePnl: "-0.5",
      fundingPnl: "1",
      holdingPnl: "1",
      complete: true,
    });
    expect(f.holdings[0]).toMatchObject({ asset: "BTC", averageCost: "50000", value: "10000" });
  });
  it("normalizes delivery contracts using metadata without assuming every symbol is perpetual", async () => {
    const t = transport((u) =>
      u.pathname === "/dapi/v1/exchangeInfo"
        ? { symbols: [{ ...contract, contractType: "CURRENT_QUARTER" }] }
        : undefined,
    );
    const cm = await new BinanceCoinFuturesClient(config, t).loadFutures();
    expect(cm.positions[0].contractType).toBe("CURRENT_QUARTER");
  });
  it("keeps all testnet requests on testnet including conversion history", async () => {
    const t = transport();
    await new BinanceCoinFuturesClient({ ...config, BINANCE_ENV: "testnet" }, t).loadFutures();
    for (const [url] of vi.mocked(t).mock.calls)
      expect(["demo-dapi.binance.com", "testnet.binance.vision"]).toContain(
        new URL(String(url)).hostname,
      );
  });
  it("never fabricates zero when account permission or settlement FX is missing", async () => {
    const noAccount = await new BinanceCoinFuturesClient(
      config,
      transport((u) =>
        u.pathname === "/dapi/v1/account" ? { code: -2015, msg: "denied" } : undefined,
      ),
    ).loadFutures();
    expect(noAccount.account).toBeUndefined();
    expect(noAccount.positionsComplete).toBe(false);
    const noFx = await new BinanceCoinFuturesClient(
      config,
      transport((u) => (u.pathname === "/api/v3/ticker/price" ? [] : undefined)),
    ).loadFutures();
    expect(noFx.account).toBeUndefined();
    expect(noFx.positionsComplete).toBe(false);
    expect(mergeFutures(empty(), noAccount).account).toBeUndefined();
  });
  it("does not merge native ledger transaction IDs across UM/CM and never adds face notional to equity", async () => {
    const cm = await fixture(),
      um = empty();
    um.account!.equity = "50";
    um.ledger.incomes = [
      {
        tranId: "1",
        symbol: "BTCUSDT",
        asset: "USDT",
        incomeType: "COMMISSION",
        income: "-2",
        time: eventTime,
      },
    ];
    const merged = mergeFutures(um, cm);
    expect(merged.account!.equity).toBe("5050");
    expect(futuresAccounting(merged).realizedPnl).toBe("-2.5");
  });
  it("matches spot and collateral coin exposure with inverse shorts", async () => {
    const d = dashboard(await fixture()),
      e = buildExposure(d);
    expect(e).toMatchObject({ long: "10000", short: "10000", net: "0", complete: true });
    expect(e.groups[0]).toMatchObject({
      spotQuantity: "0.1",
      collateralQuantity: "0.1",
      shortQuantity: "0.2",
      hedgeRatio: "100",
      holdingPnl: "2001",
      status: "数量中性",
    });
  });
  it("reprices inverse shorts and collateral together, keeping a fully hedged account neutral", async () => {
    const d = dashboard(await fixture()),
      before = structuredClone(d);
    const quotes = {
      environment: "mainnet" as const,
      spot: { time: now + 1000, prices: { BTCUSDT: "60000" } },
      futures: null,
      coinFutures: { time: now + 1000, prices: { BTCUSD_PERP: "60000" } },
    };
    const next = liveValuation(d, quotes, now + 1100);
    expect(Number(next.summary.equity)).toBeCloseTo(10000, 8);
    expect(Number(next.summary.futuresEquity)).toBeCloseTo(4000, 8);
    expect(Number(next.positionDetails![0].unRealizedProfit)).toBeCloseTo(-2000, 8);
    expect(Number(next.coinWallets![0].marginBalance)).toBeCloseTo(1 / 15, 12);
    expect(next.coinWallets![0].holdingPnl).toBe("2000");
    expect(Number(buildExposure(next).net)).toBeCloseTo(0, 8);
    expect(Number(next.summary.unrealizedPnl)).toBeCloseTo(2001, 8);
    expect(next.summary.realizedPnl).toBe("-0.5");
    expect(d).toEqual(before);
    expect(liveValuation(d, quotes, now + 1100)).toEqual(next);
  });
  it("does not reprice a coin wallet with stale inverse marks, and keeps UM and CM funding distinct", async () => {
    const d = dashboard(await fixture());
    const next = liveValuation(
      d,
      {
        environment: "mainnet",
        spot: { time: now + 1000, prices: { BTCUSDT: "60000" } },
        futures: null,
        coinFutures: null,
      },
      now + 1100,
    );
    expect(next.coinWallets).toEqual(d.coinWallets);
    expect(next.positionDetails).toEqual(d.positionDetails);
    expect(next.summary.futuresEquity).toBe("5000");
    expect(next.marketComplete).toBe(false);
  });
  it("splits saturated income windows without a page parameter or skipped timestamps", async () => {
    const calls: URL[] = [];
    const previous: FuturesLedger = {
      startTime: now - 1000,
      syncedThrough: 0,
      feeRates: {},
      incomes: [],
    };
    const cm = await new BinanceCoinFuturesClient(
      config,
      transport((u) => {
        if (u.pathname !== "/dapi/v1/income") return;
        calls.push(u);
        expect(u.searchParams.has("page")).toBe(false);
        const start = Number(u.searchParams.get("startTime")),
          end = Number(u.searchParams.get("endTime"));
        return end - start > 500
          ? Array.from({ length: 1000 }, (_, i) => ({
              ...coinIncome("TRANSFER", "0"),
              tranId: String(i),
              time: start,
            }))
          : [];
      }),
    ).loadFutures(previous);
    expect(calls.length).toBeGreaterThan(3);
    expect(cm.ledger.incomes.length).toBe(1000);
    expect(cm.complete).toBe(false); // The recent window still needs more subdivisions.
  });
  it("never declares a saturated single millisecond complete", async () => {
    const previous: FuturesLedger = {
      startTime: now - 10,
      syncedThrough: 0,
      feeRates: {},
      incomes: [],
      incomeWindows: [{ startTime: now - 5, endTime: now - 5 }],
    };
    const cm = await new BinanceCoinFuturesClient(
      config,
      transport((u) =>
        u.pathname === "/dapi/v1/income"
          ? Array.from({ length: 1000 }, (_, i) => ({
              ...coinIncome("TRANSFER", "0"),
              tranId: String(i),
            }))
          : undefined,
      ),
    ).loadFutures(previous);
    expect(cm.complete).toBe(false);
    expect(cm.ledger.incomeWindows).toHaveLength(1);
  });
  it("tracks collateral FX during the hedge and flags unexplained collateral transfers", async () => {
    const cm = await fixture();
    cm.ledger.incomes = [];
    const data: ProviderData = {
      balances: [{ asset: "BTC", free: "0.1", locked: "0" }],
      tickers: [{ symbol: "BTCUSDT", lastPrice: "50000", priceChangePercent: "0" }],
      trades: [],
      orders: [],
      warnings: [],
      ordersComplete: true,
      tradesComplete: true,
      ledger: { version: 1, markets: {} },
      futures: cm,
    };
    expect(trackHedges(data, now).BTC.netPnl).toBe("0");
    data.tickers[0].lastPrice = "60000";
    cm.coinWallets![0].price = "60000";
    cm.positions[0].unRealizedProfit = "-2000";
    expect(Number(trackHedges(data, now + 1000).BTC.netPnl)).toBeCloseTo(0);
    cm.coinWallets![0].walletBalance = "0.2";
    expect(trackHedges(data, now + 2000).BTC.netPnl).toBeNull();
  });
  it("uses inverse inventory and event-time conversion for partial short closes", async () => {
    const cm = await fixture(),
      t = cm.trades![0];
    const close: Trade = {
      ...t,
      id: "2",
      side: "BUY",
      quantity: "50",
      price: "40000",
      quoteQuantity: "5000",
      realizedPnl: "0.025",
      fee: "0.00001",
      time: eventTime + 60000,
    };
    cm.trades = [t, close];
    cm.ledger.feeRates[`BTC:${Math.floor(close.time / 60000) * 60000}`] = "40000";
    const data: ProviderData = {
      balances: [],
      tickers: [],
      trades: [],
      orders: [],
      warnings: [],
      ordersComplete: true,
      tradesComplete: true,
      ledger: { version: 1, markets: {} },
      futures: cm,
    };
    const review = closedReview(data, futuresAccounting(cm).holdings);
    expect(review.rows[0]).toMatchObject({
      asset: "BTC",
      status: "partial",
      cost: "5000",
      averageEntry: "50000",
      averageExit: "40000",
      grossPnl: "1000",
      fees: "0.65",
      netPnl: "999.35",
    });
  });
});
