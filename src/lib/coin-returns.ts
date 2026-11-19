import Decimal from "decimal.js";
import type { CoinInventory } from "./coin-inventory";
import type { CoinWallet } from "./types";

// Only settled CM income belongs here. Wallet principal, transfers, inventory
// disposal FX and unsettled PnL are not contract earnings.
const sum = (values: (string | null | undefined)[]) =>
  values.some((v) => v == null)
    ? null
    : values.reduce<Decimal>((n, v) => n.plus(v!), new Decimal(0)).toString();

export function buildCoinReturns(
  books: Record<string, CoinInventory> = {},
  wallets: CoinWallet[] = [],
) {
  const assets = [...new Set([...Object.keys(books), ...wallets.map((w) => w.asset)])].sort();
  const rows = assets.map((asset) => {
    const book = books[asset];
    const wallet = wallets.find((w) => w.asset === asset);
    const feeCoin = sum([book?.commissionCoin, book?.rebateCoin]);
    return {
      asset,
      realizedCoin: book?.realizedCoin ?? null,
      feeCoin,
      fundingCoin: book?.fundingCoin ?? null,
      netCoin: sum([book?.realizedCoin, feeCoin, book?.fundingCoin]),
      // Sum historical event valuations, never multiply total coin by today's price.
      realizedValue: sum([book?.realizedValue, book?.commissionValue, book?.rebateValue]),
      fundingValue: book?.fundingValue ?? null,
      unrealizedCoin: wallet?.unrealizedProfit ?? null,
      complete: book?.complete ?? false,
    };
  });
  return {
    rows,
    realizedValue: sum(rows.map((r) => r.realizedValue)),
    fundingValue: sum(rows.map((r) => r.fundingValue)),
    complete: rows.every((r) => r.complete),
  };
}
