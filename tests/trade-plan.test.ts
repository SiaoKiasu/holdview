import { describe, it, expect } from "vitest";
import { projectPlan, planKey, type PlanOrder } from "@/lib/trade-plan";
import type { Dashboard, Holding } from "@/lib/types";
const holding = (extra: Partial<Holding> = {}): Holding => ({
  asset: "BTC",
  free: "2",
  locked: "0",
  quantity: "2",
  price: "100",
  value: "200",
  allocation: 20,
  change24h: 0,
  averageCost: "80",
  unrealizedPnl: "40",
  ...extra,
});
const data = (holdings = [holding()]): Dashboard =>
  ({
    holdings,
    summary: {
      equity: "1000",
      equityComplete: true,
      cash: "800",
      cashFree: "300",
      cashLocked: "500",
    },
    connection: { ordersComplete: true },
  }) as Dashboard;
const order = (extra: Partial<PlanOrder> = {}): PlanOrder => ({
  id: "1",
  symbol: "BTCUSDT",
  side: "BUY",
  type: "LIMIT",
  price: "100",
  quantity: "4",
  executedQuantity: "1",
  status: "PARTIALLY_FILLED",
  time: 1,
  ...extra,
});
const choose = (orders: PlanOrder[], percent = "100") =>
  Object.fromEntries(orders.map((o) => [planKey(o), { enabled: true, percent }]));
describe("trade planning", () => {
  it("only applies the selected fraction of the unfilled quantity and releases that reservation", () => {
    const o = order(),
      p = projectPlan(data(), [o], choose([o], "50"));
    expect(p.positions[0].quantity).toBe("3.5");
    expect(Number(p.positions[0].average)).toBeCloseTo(310 / 3.5, 10);
    expect(p.cash).toBe("650");
    expect(p.locked).toBe("350");
    expect(p.free).toBe("300");
    expect(p.positions[0].allocation).toBe("31");
  });
  it("leaves unselected orders and the current portfolio unchanged", () => {
    const p = projectPlan(data(), [order()], {});
    expect(p.buy).toBe("0");
    expect(p.positions[0].quantity).toBe("2");
    expect(p.free).toBe("300");
  });
  it("supports manual buys, sells, and per-trade fees without moving buy fees into average cost", () => {
    const orders = [
      order({ quantity: "1", executedQuantity: "0", manual: true }),
      order({
        id: "2",
        side: "SELL",
        quantity: "1.5",
        executedQuantity: "0",
        price: "120",
        manual: true,
      }),
    ];
    const p = projectPlan(data(), orders, choose(orders), "1");
    expect(p.valid).toBe(true);
    expect(p.positions[0].quantity).toBe("1.5");
    expect(Number(p.positions[0].average)).toBeCloseTo(260 / 3);
    expect(p.cash).toBe("877.2");
    expect(p.fees).toBe("2.8");
    expect(Number(p.selectedPnl)).toBeCloseTo(47.2);
  });
  it("rejects oversells, invalid percentages and OCO double selection", () => {
    const sell = order({ side: "SELL", quantity: "5", executedQuantity: "0" });
    expect(projectPlan(data(), [sell], choose([sell])).valid).toBe(false);
    expect(projectPlan(data(), [order()], choose([order()], "101")).valid).toBe(false);
    const linked = [order({ orderListId: "4" }), order({ id: "2", orderListId: "4" })];
    expect(projectPlan(data(), linked, choose(linked)).valid).toBe(false);
  });
  it("preserves unknown costs and an explicit zero cost", () => {
    const o = order();
    expect(
      projectPlan(data([holding({ averageCost: null })]), [o], choose([o])).positions[0].average,
    ).toBeNull();
    expect(projectPlan(data([holding({ averageCost: "0" })]), [], {}).positions[0].average).toBe(
      "0",
    );
  });
  it("keeps futures and spot holdings separate, and never deducts futures notional from spot cash", () => {
    const o = order({ instrument: "futures", quantity: "1", executedQuantity: "0" });
    const p = projectPlan(
      data([holding(), holding({ instrument: "futures", symbol: "BTCUSDT", direction: "多" })]),
      [o],
      choose([o]),
    );
    expect(p.positions).toHaveLength(2);
    expect(p.cash).toBe("800");
    expect(p.positions.find((x) => x.futures)?.quantity).toBe("3");
  });
  it("does not simulate unsupported pairs, short or close-all orders as long USDT orders", () => {
    for (const o of [
      order({ symbol: "ETHBTC" }),
      order({ instrument: "futures", positionSide: "SHORT" }),
      order({ instrument: "futures", closePosition: true }),
    ])
      expect(projectPlan(data(), [o], choose([o])).valid).toBe(false);
  });
  it("marks unknown quote amounts and incomplete data unavailable", () => {
    const d = data();
    d.connection.ordersComplete = false;
    d.summary.equityComplete = false;
    const p = projectPlan(d, [order()], {});
    expect(p.rows[0].filledAllocation).toBeNull();
    expect(p.free).toBeNull();
    expect(p.allocation).toBeNull();
  });
  it("warns when manual purchases spend funds reserved for other open orders", () => {
    const o = order({ manual: true, quantity: "4", executedQuantity: "0" });
    const p = projectPlan(data(), [o], choose([o]));
    expect(p.free).toBe("-100");
    expect(p.notices.join("")).toContain("可用现金不足");
  });
});

it("does not treat a one-way short closing buy as a new long position", () => {
  const o = order({ instrument: "futures", positionSide: "BOTH" });
  const d = data([holding({ instrument: "futures", symbol: "BTCUSDT", direction: "空" })]);
  expect(projectPlan(d, [o], choose([o])).valid).toBe(false);
});
it("warns when a manual sale would consume quantities frozen in unselected sell orders", () => {
  const o = order({ manual: true, side: "SELL", quantity: "1", executedQuantity: "0" });
  const p = projectPlan(data([holding({ free: "0.5", locked: "1.5" })]), [o], choose([o]));
  expect(p.notices.join("")).toContain("未选卖单冻结");
});
