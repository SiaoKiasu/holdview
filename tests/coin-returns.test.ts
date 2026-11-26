import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildCoinReturns } from "@/lib/coin-returns";
import { CoinReturnsPanel } from "@/components/coin-returns-panel";
import type { CoinInventory } from "@/lib/coin-inventory";
import type { CoinWallet } from "@/lib/types";

const book = (extra: Partial<CoinInventory> = {}): CoinInventory => ({
  quantity: "2",
  averageCost: "50000",
  cost: "100000",
  realizedCoin: "0.002",
  commissionCoin: "-0.0001",
  rebateCoin: "0.00002",
  fundingCoin: "-0.0003",
  realizedValue: "120",
  commissionValue: "-6.5",
  rebateValue: "1.4",
  fundingValue: "-21",
  disposalPnl: "-3",
  complete: true,
  issues: [],
  ...extra,
});
const wallet: CoinWallet = {
  asset: "BTC",
  walletBalance: "2",
  marginBalance: "2.001",
  unrealizedProfit: "0.001",
  availableBalance: "1",
  initialMargin: "0.1",
  price: "90000",
};

describe("coin-margined settled returns", () => {
  it("nets settled coin independently of wallet principal, price, disposal FX and open PnL", () => {
    const r = buildCoinReturns({ BTC: book() }, [wallet]);
    expect(r.rows[0]).toMatchObject({
      feeCoin: "-0.00008",
      netCoin: "0.00162",
      realizedValue: "114.9",
      unrealizedCoin: "0.001",
      currentCoin: "2",
      initialCoin: "1.99838",
      unrealizedValue: "90",
    });
    expect(r.fundingValue).toBe("-21");
    // A mark-price move cannot change earned coins or their historical valuation.
    const repriced = buildCoinReturns({ BTC: book({ quantity: "20", disposalPnl: "200" }) }, [
      { ...wallet, price: "100000", unrealizedProfit: "0.02" },
    ]);
    expect(repriced.rows[0].unrealizedValue).toBe("2000");
    expect(repriced.rows[0].initialCoin).toBe("19.99838");
    expect(repriced.realizedValue).toBe(r.realizedValue);
    expect(repriced.rows[0].netCoin).toBe(r.rows[0].netCoin);
  });
  it("keeps native currencies separate and includes closed wallets' income", () => {
    const r = buildCoinReturns(
      {
        BTC: book(),
        ETH: book({
          realizedCoin: "-1",
          commissionCoin: "-0.01",
          rebateCoin: "0",
          fundingCoin: "0.02",
          realizedValue: "-2000",
          commissionValue: "-20",
          rebateValue: "0",
          fundingValue: "40",
        }),
      },
      [wallet],
    );
    expect(r.rows[1].netCoin).toBe("-0.99");
    expect(r.rows[1].unrealizedCoin).toBeNull();
    expect(r.realizedValue).toBe("-1905.1");
    expect(r.fundingValue).toBe("19");
    expect(r).not.toHaveProperty("netCoin");
  });
  it("does not silently convert missing valuations or missing books into zero", () => {
    const r = buildCoinReturns({ BTC: book({ commissionValue: null, complete: false }) }, [
      { ...wallet, asset: "ETH" },
    ]);
    expect(r.realizedValue).toBeNull();
    expect(r.fundingValue).toBeNull();
    expect(r.complete).toBe(false);
    expect(r.rows[0].netCoin).toBe("0.00162");
    expect(r.rows[1].netCoin).toBeNull();
    expect(r.rows[0].initialCoin).toBeNull();
    expect(r.rows[1].currentCoin).toBeNull();
  });
  it("immediately recognizes fees before any position is closed", () => {
    const r = buildCoinReturns({
      BTC: book({
        realizedCoin: "0",
        realizedValue: "0",
        fundingCoin: "0",
        fundingValue: "0",
        rebateCoin: "0",
        rebateValue: "0",
      }),
    });
    expect(r.rows[0].netCoin).toBe("-0.0001");
    expect(r.realizedValue).toBe("-6.5");
  });
  it("presents tentative data and hides all financial numbers in privacy mode", () => {
    const data = { coinInventory: { BTC: book({ complete: false }) }, coinWallets: [wallet] };
    const html = renderToStaticMarkup(createElement(CoinReturnsPanel, { data, hidden: false }));
    expect(html).toContain("历史流水待核对");
    expect(html).toContain("+0.00162");
    expect(html).toContain("+114.90");
    const masked = renderToStaticMarkup(createElement(CoinReturnsPanel, { data, hidden: true }));
    expect(masked).toContain("••••");
    expect(masked).not.toMatch(/0\.00162|114\.90|0\.00008|21\.00/);
    expect(masked).not.toContain('class="negative"');
  });
  it("omits the panel for an account with no coin-margined data", () => {
    expect(renderToStaticMarkup(createElement(CoinReturnsPanel, { data: {}, hidden: false }))).toBe(
      "",
    );
  });
});
