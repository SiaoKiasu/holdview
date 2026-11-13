import Decimal from "decimal.js";
import type { FuturesData, FuturesLedger } from "./types";
const D = (v: string) => new Decimal(v);
// Persist UM and CM cursors independently. This merged ledger is calculation-only.
export function mergeFutures(
  um: FuturesData | undefined,
  cm: FuturesData | undefined,
): FuturesData {
  const all = [um, cm].filter((v): v is FuturesData => !!v);
  const empty: FuturesLedger = {
    incomes: [],
    feeRates: {},
    startTime: Date.now(),
    syncedThrough: 0,
  };
  const ledger = all.reduce<FuturesLedger>(
    (a, v) => ({
      ...a,
      incomes: [...a.incomes, ...v.ledger.incomes],
      feeRates: { ...a.feeRates, ...v.ledger.feeRates },
      startTime: Math.min(a.startTime, v.ledger.startTime),
      historyGap: a.historyGap || v.ledger.historyGap,
    }),
    empty,
  );
  const sum = (key: "equity" | "walletBalance" | "availableBalance" | "initialMargin") =>
    D(um!.account![key]).plus(cm!.account![key]).toString();
  return {
    account:
      um?.account && cm?.account
        ? {
            equity: sum("equity"),
            walletBalance: sum("walletBalance"),
            availableBalance: sum("availableBalance"),
            initialMargin: sum("initialMargin"),
          }
        : undefined,
    coinWallets: cm?.coinWallets ?? [],
    positions: all.flatMap((v) => v.positions),
    positionsComplete: um?.positionsComplete === true && cm?.positionsComplete === true,
    orders: all.flatMap((v) => v.orders ?? []),
    ordersComplete: um?.ordersComplete === true && cm?.ordersComplete === true,
    trades: all.flatMap((v) => v.trades ?? []),
    tradesComplete: um?.tradesComplete === true && cm?.tradesComplete === true,
    ledger,
    complete: um?.complete === true && cm?.complete === true,
    warnings: [
      ...all.flatMap((v) => v.warnings),
      ...(!cm ? ["币本位账户未能读取，账户总额暂不完整。"] : []),
    ],
  };
}
