import "server-only";
import { z } from "zod";
import Decimal from "decimal.js";
import { BinanceClient } from "./binance";
import type { Config } from "./config";
import type { FuturesData, FuturesIncome, FuturesLedger } from "./types";

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const transactionId = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().safe().transform(String),
]);
const incomeSchema = z.array(
  z.object({
    tranId: transactionId,
    symbol: z.string(),
    incomeType: z.string(),
    income: decimal,
    asset: z.string(),
    time: z.number().int(),
  }),
);
const positionsSchema = z.array(
  z.object({
    symbol: z.string(),
    positionSide: z.enum(["BOTH", "LONG", "SHORT"]),
    positionAmt: decimal,
    entryPrice: decimal,
    markPrice: decimal,
    unRealizedProfit: decimal,
    marginAsset: z.string(),
  }),
);
const DAY = 86400000;
export const incomeKey = (i: FuturesIncome) => `${i.incomeType}:${i.tranId}`;
export const incomeRateKey = (i: FuturesIncome) =>
  `${i.asset}:${Math.floor(i.time / 60000) * 60000}`;

export class BinanceFuturesClient extends BinanceClient {
  constructor(
    c: Pick<Config, "BINANCE_ENV" | "BINANCE_API_KEY" | "BINANCE_API_SECRET">,
    transport: typeof fetch = fetch,
    private until = Date.now() + 25000,
  ) {
    super(c, transport, until, "futures");
  }
  async loadFutures(previous?: FuturesLedger): Promise<FuturesData> {
    await this.syncTime();
    const positions = positionsSchema
      .parse(await this.request("/fapi/v3/positionRisk", {}, true))
      .filter((p) => !new Decimal(p.positionAmt).isZero());
    const now = Date.now();
    const ledger: FuturesLedger = structuredClone(
      previous ?? {
        incomes: [],
        startTime: now - 89 * DAY,
        syncedThrough: 0,
        feeRates: {},
      },
    );
    const warnings: string[] = [];
    const incomes = new Map(ledger.incomes.map((i) => [incomeKey(i), i]));
    const merge = (rows: FuturesIncome[]) => rows.forEach((i) => incomes.set(incomeKey(i), i));
    const page = async (startTime: number, endTime: number, p: number) =>
      incomeSchema.parse(
        await this.request(
          "/fapi/v1/income",
          {
            startTime: String(startTime),
            endTime: String(endTime),
            page: String(p),
            limit: "1000",
          },
          true,
        ),
      );
    let recentComplete = false;
    // Always read recent events first, even while older pages are still being backfilled.
    try {
      let n = 1;
      for (; n <= 3 && Date.now() < this.until - 1000; n++) {
        const rows = await page(now - 7 * DAY, now, n);
        merge(rows);
        if (rows.length < 1000) {
          recentComplete = true;
          break;
        }
      }
      if (!recentComplete) warnings.push("合约近期流水较多，正在继续同步。");
    } catch {
      recentComplete = false;
      warnings.push("合约最新资金流水暂未读取成功，请稍后刷新。");
    }
    if (previous && (ledger.syncedThrough || ledger.startTime) < now - 90 * DAY)
      ledger.historyGap = true;
    if (!ledger.pending)
      ledger.pending = {
        startTime: Math.max(ledger.startTime, ledger.syncedThrough - DAY),
        endTime: now,
        page: 1,
      };
    let historyComplete = false;
    try {
      for (let n = 0; n < 5 && Date.now() < this.until - 1000; n++) {
        const window = ledger.pending!;
        const rows = await page(window.startTime, window.endTime, window.page);
        merge(rows);
        if (rows.length < 1000) {
          ledger.syncedThrough = window.endTime;
          delete ledger.pending;
          historyComplete = true;
          break;
        }
        window.page++;
      }
    } catch {
      warnings.push("合约历史流水同步暂时中断，下次刷新将继续。");
    }
    ledger.incomes = [...incomes.values()].sort((a, b) => a.time - b.time);
    // Preserve fees in their original currency; convert third-token fees at event-time prices.
    const missingRates = new Map(
      ledger.incomes
        .filter(
          (i) =>
            i.asset !== "USDT" &&
            !new Decimal(i.income).isZero() &&
            ["COMMISSION", "REALIZED_PNL", "FUNDING_FEE"].includes(i.incomeType) &&
            !ledger.feeRates[incomeRateKey(i)],
        )
        .map((i) => [incomeRateKey(i), i]),
    );
    for (const [key, i] of [...missingRates].slice(0, 8)) {
      if (Date.now() >= this.until - 1000) break;
      try {
        const start = Math.floor(i.time / 60000) * 60000;
        const rows = z.array(z.array(z.unknown())).parse(
          await this.request("/fapi/v1/klines", {
            symbol: `${i.asset}USDT`,
            interval: "1m",
            startTime: String(start),
            endTime: String(start + 59999),
            limit: "1",
          }),
        );
        if (rows[0]?.[0] === start) {
          const rate = decimal.parse(rows[0][4]);
          if (new Decimal(rate).gt(0)) ledger.feeRates[key] = rate;
        }
      } catch {
        /* A missing conversion remains unknown, never silently zero. */
      }
    }
    if (!historyComplete) warnings.push("合约历史流水同步中，盈亏为已读取流水的暂计值。");
    if (ledger.historyGap)
      warnings.push("合约流水存在超出接口保留期的缺口，请管理员核对历史资金记录。");
    return {
      positions,
      ledger,
      complete: recentComplete && historyComplete && !ledger.historyGap,
      warnings,
    };
  }
}
