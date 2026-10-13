import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config";
import { AppError } from "./errors";
import type { ProviderData, Trade, TradeLedger } from "./types";
import { feeRateKey } from "./trade-pnl";
const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const id = z.number().int().safe().transform(String);
const tradeSchema = z.array(
  z.object({
    id,
    symbol: z.string(),
    price: decimal,
    qty: decimal,
    quoteQty: decimal,
    commission: decimal,
    commissionAsset: z.string(),
    time: z.number(),
    isBuyer: z.boolean(),
    isMaker: z.boolean(),
  }),
);
export function signQuery(query: string, secret: string) {
  return createHmac("sha256", secret).update(query).digest("hex");
}
export class BinanceClient {
  private offset = 0;
  private base: string;
  constructor(
    private config: Pick<Config, "BINANCE_ENV" | "BINANCE_API_KEY" | "BINANCE_API_SECRET">,
    private transport: typeof fetch = fetch,
    private deadline = Date.now() + 40000,
    private market: "spot" | "futures" = "spot",
  ) {
    this.base =
      market === "futures"
        ? config.BINANCE_ENV === "testnet"
          ? "https://demo-fapi.binance.com"
          : "https://fapi.binance.com"
        : config.BINANCE_ENV === "testnet"
          ? "https://testnet.binance.vision"
          : "https://api.binance.com";
  }
  async request(
    path: string,
    params: Record<string, string> = {},
    signed = false,
  ): Promise<unknown> {
    // This adapter intentionally exposes only GET calls; no trading/withdrawal endpoint exists.
    const query = new URLSearchParams(params);
    if (signed) {
      query.set("timestamp", String(Date.now() + this.offset));
      query.set("recvWindow", "10000");
      query.set("signature", signQuery(query.toString(), this.config.BINANCE_API_SECRET));
    }
    let response: Response;
    try {
      response = await this.transport(`${this.base}${path}?${query}`, {
        method: "GET",
        cache: "no-store",
        headers: signed ? { "X-MBX-APIKEY": this.config.BINANCE_API_KEY } : {},
        signal: AbortSignal.timeout(Math.max(1, Math.min(10000, this.deadline - Date.now()))),
      });
    } catch {
      throw new AppError(
        "EXCHANGE_NETWORK",
        "无法连接 Binance，请检查网络、部署区域或稍后重试。",
        502,
      );
    }
    if (response.status === 451 || response.status === 403)
      throw new AppError(
        "EXCHANGE_REGION",
        "Binance 拒绝了当前部署出口。请核对账户适用地区及部署区域。",
        502,
      );
    if (response.status === 429 || response.status === 418)
      throw new AppError("EXCHANGE_RATE_LIMIT", "交易所请求过于频繁，请暂停刷新，稍后重试。", 429);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AppError("EXCHANGE_RESPONSE", "交易所返回了无法解析的响应。", 502);
    }
    if (!response.ok) {
      const code = (data as { code?: number })?.code;
      const messages: Record<number, string> = {
        [-2015]: "API Key、读取权限或 IP 白名单不匹配。",
        [-2014]: "API Key 格式不正确。",
        [-1022]: "API 签名无效，请检查 Secret 与 API Key 是否配对。",
        [-1021]: "交易所时间校验失败，请重试。",
        [-1121]: "监控交易对不可用，请联系管理员。",
      };
      throw new AppError(
        "EXCHANGE_ERROR",
        (code && messages[code]) || "交易所暂时无法处理查询。",
        502,
      );
    }
    return data;
  }
  async syncTime() {
    const start = Date.now();
    const data = z
      .object({ serverTime: z.number() })
      .parse(await this.request(this.market === "futures" ? "/fapi/v1/time" : "/api/v3/time"));
    this.offset = data.serverTime - Math.round((start + Date.now()) / 2);
  }
  async trades(symbol: string, fromId?: string, limit = 100): Promise<Trade[]> {
    const rows = tradeSchema.parse(
      await this.request(
        "/api/v3/myTrades",
        { symbol, limit: String(limit), ...(fromId ? { fromId } : {}) },
        true,
      ),
    );
    return rows.map((t) => ({
      id: t.id,
      symbol: t.symbol,
      side: t.isBuyer ? "BUY" : "SELL",
      price: t.price,
      quantity: t.qty,
      quoteQuantity: t.quoteQty,
      fee: t.commission,
      feeAsset: t.commissionAsset,
      time: t.time,
      isMaker: t.isMaker,
    }));
  }
  async loadBalances() {
    await this.syncTime();
    const account = z
      .object({
        balances: z.array(z.object({ asset: z.string(), free: decimal, locked: decimal })),
      })
      .parse(await this.request("/api/v3/account", { omitZeroBalances: "true" }, true));
    const warnings: string[] = [];
    const [prices, wallet] = await Promise.allSettled([
      this.request("/api/v3/ticker/24hr"),
      this.loadSpotEquity(),
    ]);
    const parsedPrices =
      prices.status === "fulfilled"
        ? z
            .array(
              z.object({
                symbol: z.string(),
                lastPrice: decimal,
                priceChangePercent: z.string().regex(/^-?\d+(\.\d+)?$/),
              }),
            )
            .safeParse(prices.value)
        : null;
    const tickers = parsedPrices?.success ? parsedPrices.data : [];
    if (!parsedPrices?.success) warnings.push("行情暂时无法读取，持仓估值和未实现盈亏可能不完整。");
    const spotEquity = wallet.status === "fulfilled" ? wallet.value : null;
    if (wallet.status === "rejected")
      warnings.push("交易所现货总资产暂时无法读取，当前按余额和行情估算。");
    return { balances: account.balances, tickers, spotEquity, warnings };
  }
  async loadSpotEquity(): Promise<string | null> {
    // SAPI wallet endpoints are mainnet-only; never send testnet keys to mainnet.
    if (this.config.BINANCE_ENV === "testnet") return null;
    const wallets = z
      .array(z.object({ walletName: z.string() }).passthrough())
      .parse(await this.request("/sapi/v1/asset/wallet/balance", { quoteAsset: "USDT" }, true));
    // The endpoint also includes futures/funding wallets. Only Spot matches our holdings scope.
    const spot = wallets.filter((wallet) => wallet.walletName === "Spot");
    if (spot.length !== 1)
      throw new AppError("EXCHANGE_RESPONSE", "现货钱包估值缺失或不明确。", 502);
    return z.object({ balance: decimal, activate: z.literal(true) }).parse(spot[0]).balance;
  }
  async load(symbols: string[] = [], previous?: TradeLedger): Promise<ProviderData> {
    const { balances, tickers, spotEquity, warnings } = await this.loadBalances();
    let orders: ProviderData["orders"] = [];
    let ordersComplete = true;
    let tradesComplete = true;
    try {
      orders = z
        .array(
          z.object({
            orderId: id,
            symbol: z.string(),
            side: z.enum(["BUY", "SELL"]),
            type: z.string(),
            price: decimal,
            origQty: decimal,
            executedQty: decimal,
            status: z.string(),
            time: z.number(),
          }),
        )
        .parse(await this.request("/api/v3/openOrders", {}, true))
        .map((o) => ({
          id: o.orderId,
          symbol: o.symbol,
          side: o.side,
          type: o.type,
          price: o.price,
          quantity: o.origQty,
          executedQuantity: o.executedQty,
          status: o.status,
          time: o.time,
        }));
    } catch (e) {
      ordersComplete = false;
      warnings.push(`挂单读取失败：${e instanceof AppError ? e.message : "返回数据格式异常"}`);
    }
    const ledger: TradeLedger = structuredClone(previous ?? { version: 1, markets: {} });
    let catalogComplete = true;
    try {
      const info = z
        .object({
          symbols: z.array(
            z.object({
              symbol: z.string(),
              baseAsset: z.string(),
              quoteAsset: z.string(),
              isSpotTradingAllowed: z.boolean().optional(),
            }),
          ),
        })
        .parse(await this.request("/api/v3/exchangeInfo"));
      if (!info.symbols.length) throw new Error("empty market catalog");
      for (const market of info.symbols) {
        if (market.isSpotTradingAllowed === false) continue;
        ledger.markets[market.symbol] ??= {
          baseAsset: market.baseAsset,
          quoteAsset: market.quoteAsset,
          nextId: "0",
          complete: false,
          checkedAt: 0,
          trades: [],
        };
      }
    } catch {
      catalogComplete = false;
      warnings.push("交易对目录暂未读取成功，历史发现暂停；余额仍可查看。");
    }
    // Legacy configured pairs are optional discovery hints, never a holdings filter.
    for (const symbol of symbols)
      if (!ledger.markets[symbol] && symbol.endsWith("USDT")) {
        ledger.markets[symbol] = {
          baseAsset: symbol.slice(0, -4),
          quoteAsset: "USDT",
          nextId: "0",
          complete: false,
          checkedAt: 0,
          trades: [],
        };
      }
    const held = new Set(
      balances.filter((b) => Number(b.free) + Number(b.locked) > 0).map((b) => b.asset),
    );
    const open = new Set(orders.map((o) => o.symbol));
    const entries = Object.entries(ledger.markets);
    const important = ([symbol, m]: (typeof entries)[number]) =>
      held.has(m.baseAsset) || open.has(symbol) || m.trades.length > 0;
    // Actual account activity must lead untouched markets sharing the same base asset.
    // Otherwise BTC's many unscanned quote pairs can delay a BTCUSDT sale for hours.
    const activityRank = ([symbol, m]: (typeof entries)[number]) =>
      m.trades.length > 0 || open.has(symbol) ? 0 : m.quoteAsset === "USDT" ? 1 : 2;
    // Reserve most of each batch for discovery/rotation so active pairs cannot starve closed positions.
    const priority = entries
      .filter((e) => important(e) && Date.now() - e[1].checkedAt >= 30000)
      .sort((a, b) => activityRank(a) - activityRank(b) || a[1].checkedAt - b[1].checkedAt)
      .slice(0, 8);
    const chosen = new Set(priority.map(([s]) => s));
    const remaining = entries
      .filter(([s]) => !chosen.has(s))
      .sort(
        (a, b) => Number(a[1].complete) - Number(b[1].complete) || a[1].checkedAt - b[1].checkedAt,
      );
    const queue = [...priority, ...remaining].slice(0, 24);
    let failed = false;
    let throttled = false;
    for (const [symbol, market] of queue) {
      if (Date.now() >= this.deadline - 2000) break;
      try {
        const rows = await this.trades(symbol, market.nextId, 1000);
        // Repeat reads and retries are idempotent even if an upstream page overlaps.
        const unique = new Map(market.trades.map((t) => [t.id, t]));
        for (const row of rows) unique.set(row.id, row);
        market.trades = [...unique.values()];
        if (rows.length) {
          const last = rows.reduce(
            (max, t) => (BigInt(t.id) > max ? BigInt(t.id) : max),
            BigInt(market.nextId) - 1n,
          );
          market.nextId = (last + 1n).toString();
        }
        market.complete = rows.length < 1000;
        market.checkedAt = Date.now();
      } catch (e) {
        failed = true;
        market.complete = false;
        // Rotate failed symbols behind other work; retry on subsequent refreshes.
        market.checkedAt = Date.now();
        warnings.push(
          `${symbol} 成交读取失败：${e instanceof AppError ? e.message : "返回数据格式异常"}`,
        );
        if (e instanceof AppError && e.code === "EXCHANGE_RATE_LIMIT") {
          throttled = true;
          break;
        }
      }
    }
    if (!throttled) await this.syncFeeRates(ledger);
    const markets = Object.values(ledger.markets);
    const scanned = markets.filter((m) => m.complete).length;
    tradesComplete = catalogComplete && !failed && markets.length > 0 && scanned === markets.length;
    if (!tradesComplete)
      warnings.push(
        `历史自动同步中：${scanned}/${markets.length} 个交易对已完成首次回溯。保持页面打开会继续同步，包括已清仓交易对。`,
      );
    warnings.push(
      "成交历史按 API 可获得范围同步，可能缺少已下架交易对、闪兑和转账记录。不同交易对分批更新。",
    );
    const checked = markets.filter((m) => m.complete).map((m) => m.checkedAt);
    return {
      balances,
      tickers,
      spotEquity,
      trades: markets.flatMap((m) => m.trades).sort((a, b) => b.time - a.time),
      orders,
      warnings,
      tradesComplete,
      ordersComplete,
      ledger,
      historySync: {
        scanned,
        total: markets.length,
        oldestCheck: checked.length ? Math.min(...checked) : null,
      },
    };
  }
  async syncFeeRates(ledger: TradeLedger) {
    const rates = (ledger.feeRates ??= {});
    const needed = new Map<string, { asset: string; minute: number }>();
    for (const market of Object.values(ledger.markets)) {
      if (market.quoteAsset !== "USDT") continue;
      for (const trade of market.trades) {
        if (
          Number(trade.fee) <= 0 ||
          trade.feeAsset === "USDT" ||
          trade.feeAsset === market.baseAsset
        )
          continue;
        const key = feeRateKey(trade.feeAsset, trade.time);
        const minute = Math.floor(trade.time / 60000) * 60000;
        if (rates[key]?.price || minute + 60000 > Date.now()) continue;
        if (rates[key] && Date.now() - rates[key].checkedAt < 300000) continue;
        needed.set(key, { asset: trade.feeAsset, minute });
      }
    }
    // Persist successes and retry timestamps so old failures cannot starve new fees.
    const queue = [...needed]
      .sort(([a], [b]) => (rates[a]?.checkedAt ?? 0) - (rates[b]?.checkedAt ?? 0))
      .slice(0, 12);
    for (const [key, { asset, minute }] of queue) {
      if (Date.now() >= this.deadline - 2000) break;
      try {
        const rows = z
          .array(
            z
              .tuple([z.number(), decimal, decimal, decimal, decimal, decimal, z.number()])
              .rest(z.unknown()),
          )
          .parse(
            await this.request("/api/v3/klines", {
              symbol: `${asset}USDT`,
              interval: "1m",
              startTime: String(minute),
              endTime: String(minute + 59999),
              limit: "1",
            }),
          );
        const row = rows[0];
        if (
          rows.length !== 1 ||
          row[0] !== minute ||
          row[6] !== minute + 59999 ||
          Number(row[4]) <= 0
        )
          throw new Error("Historical fee rate unavailable");
        rates[key] = { price: row[4], checkedAt: Date.now() };
      } catch (e) {
        rates[key] = { price: null, checkedAt: Date.now() };
        if (e instanceof AppError && e.code === "EXCHANGE_RATE_LIMIT") break;
      }
    }
  }
}
