import { authorizeAccount, authenticatedJson } from "@/lib/auth";
import { dashboard } from "@/lib/service";
import { failure } from "@/lib/http";
import { tradeSymbolPattern } from "@/lib/asset-symbol.mjs";
import { AppError } from "@/lib/errors";
import { BinanceClient } from "@/lib/binance";
import { BinanceFuturesClient } from "@/lib/binance-futures";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request, context: { params: Promise<{ resource: string }> }) {
  try {
    const auth = await authorizeAccount(request);
    const c = auth.config;
    const respond = (data: unknown) => authenticatedJson(data, auth);
    const { resource } = await context.params;
    if (
      !["dashboard", "holdings", "pnl", "trades", "orders", "history", "connection"].includes(
        resource,
      )
    )
      throw new AppError("NOT_FOUND", "接口不存在。", 404);
    const url = new URL(request.url);
    const market = url.searchParams.get("market");
    if (resource === "trades" && market && !["spot", "futures"].includes(market))
      throw new AppError("INVALID_QUERY", "market 应为 spot 或 futures。", 400);
    if (
      resource === "trades" &&
      !url.searchParams.has("symbol") &&
      (url.searchParams.has("fromId") || url.searchParams.has("limit"))
    )
      throw new AppError("INVALID_QUERY", "分页成交需要同时指定 symbol。", 400);
    if (resource === "trades" && url.searchParams.has("symbol")) {
      const symbol = url.searchParams.get("symbol")!;
      const fromId = url.searchParams.get("fromId") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? 100);
      if (
        !tradeSymbolPattern.test(symbol) ||
        (fromId && !/^\d{1,20}$/.test(fromId)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new AppError(
          "INVALID_QUERY",
          "交易对格式无效，limit 应为 1–1000，fromId 为交易 ID。",
          400,
        );
      if (c.DATA_SOURCE === "binance") {
        const client = market === "futures" ? new BinanceFuturesClient(c) : new BinanceClient(c);
        await client.syncTime();
        const trades =
          client instanceof BinanceFuturesClient
            ? await client.futuresTrades(symbol, {
                limit: String(limit),
                ...(fromId ? { fromId } : {}),
              })
            : await client.trades(symbol, fromId, limit);
        return respond({
          data: trades,
          nextFromId:
            trades.length === limit ? (BigInt(trades[trades.length - 1].id) + 1n).toString() : null,
          coverage:
            market === "futures"
              ? "合约成交最多回溯三个月；未传 fromId 时返回最近七天成交。"
              : "未传 fromId 时返回最近成交；fromId=0 可从最早可用成交向后分页。",
        });
      }
      const trades = (await dashboard(c)).trades
        .filter(
          (t) =>
            (t.instrument ?? "spot") === (market ?? "spot") &&
            t.symbol === symbol &&
            (!fromId || BigInt(t.id) >= BigInt(fromId)),
        )
        .sort((a, b) => a.time - b.time)
        .slice(0, limit);
      return respond({ data: trades, nextFromId: null, coverage: "模拟成交" });
    }
    const result = await dashboard(c);
    if (resource === "dashboard") return respond(result);
    if (resource === "pnl")
      return respond({
        data: result.summary,
        warnings: result.warnings,
        updatedAt: result.updatedAt,
      });
    if (resource === "connection")
      return respond({
        data: { source: result.source, environment: result.environment, ...result.connection },
        warnings: result.warnings,
        updatedAt: result.updatedAt,
      });
    return respond({
      data:
        resource === "trades" && market
          ? result.trades.filter((t) => (t.instrument ?? "spot") === market)
          : result[resource as "holdings" | "trades" | "orders" | "history"],
      updatedAt: result.updatedAt,
      warnings: result.warnings,
    });
  } catch (e) {
    return failure(e);
  }
}
