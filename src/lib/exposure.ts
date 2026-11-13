import Decimal from "decimal.js";
import { supportedPosition, positionAsset } from "./futures-units";
import { STABLECOINS } from "./assets";
import type { Dashboard, FuturesPosition, Holding } from "./types";

const D = (v: string | number) => new Decimal(v);
export type PositionGroup = {
  asset: string;
  spot?: Holding;
  positions: FuturesPosition[];
  spotQuantity: string;
  collateralQuantity: string;
  collateralPrice: string | null;
  collateralWallet?: import("./types").CoinWallet;
  longQuantity: string;
  shortQuantity: string;
  netQuantity: string | null;
  referencePrice: string | null;
  longExposure: string | null;
  shortExposure: string | null;
  netExposure: string | null;
  grossExposure: string | null;
  hedgeRatio: string | null;
  hedgedValue: string | null;
  floatingPnl: string | null;
  fundingPnl: string | null;
  holdingPnl: string | null;
  pnlComplete: boolean;
  status: string;
  stable: boolean;
  hedged: boolean;
};

export function buildExposure(
  data: Pick<Dashboard, "holdings" | "positionDetails" | "connection" | "summary" | "coinWallets">,
) {
  const positionsReady =
    !data.connection.futuresEnabled || data.connection.futuresPositionsComplete === true;
  const raw = data.positionDetails ?? [];
  // Exact base-asset matching only. Multiplier contracts (e.g. 1000PEPE) are not
  // silently paired with PEPE; inverse contracts require explicit metadata and conversion.
  const supported = raw.filter((p) => supportedPosition(p) && !D(p.positionAmt).isZero());
  const unsupported = raw.filter((p) => !supportedPosition(p));
  const wallets = data.coinWallets ?? [];
  const spot = data.holdings.filter((h) => h.instrument !== "futures");
  const groups: PositionGroup[] = [
    ...new Set([
      ...spot.map((h) => h.asset),
      ...supported.map(positionAsset),
      ...wallets.map((w) => w.asset),
    ]),
  ]
    .map((asset) => {
      const s = spot.find((h) => h.asset === asset);
      const ps = supported.filter((p) => positionAsset(p) === asset);
      const wallet = wallets.find((w) => w.asset === asset);
      const collateral = D(wallet?.marginBalance ?? 0);
      const stable = STABLECOINS.has(asset);
      const sq = D(s?.quantity ?? 0);
      const lq = ps
        .filter((p) => D(p.positionAmt).gt(0))
        .reduce((v, p) => v.plus(p.positionAmt), D(0));
      const bq = ps
        .filter((p) => D(p.positionAmt).lt(0))
        .reduce((v, p) => v.plus(D(p.positionAmt).abs()), D(0));
      const totalLong = sq.plus(lq).plus(collateral);
      const ref =
        s?.price ?? wallet?.price ?? ps.find((p) => D(p.markPrice).gt(0))?.markPrice ?? null;
      const known = positionsReady && ref !== null && D(ref).gt(0);
      const net = totalLong.minus(bq);
      const ratio = positionsReady && totalLong.gt(0) ? bq.div(totalLong).mul(100) : null;
      const hedged = positionsReady && !stable && totalLong.gt(0) && bq.gt(0);
      const floating =
        positionsReady && (!s || stable || s.unrealizedPnl !== null)
          ? wallet && wallet.holdingPnl == null
            ? null
            : ps
                .reduce(
                  (v, p) => v.plus(p.unRealizedProfit),
                  D(stable ? 0 : (s?.unrealizedPnl ?? 0)),
                )
                .plus(wallet?.holdingPnl ?? 0)
          : null;
      const legacy = data.holdings.filter((h) => h.instrument === "futures" && h.asset === asset);
      const funding = legacy.some((h) => h.fundingPnl == null)
        ? null
        : legacy.length
          ? legacy.reduce((v, h) => v.plus(h.fundingPnl!), D(0)).toString()
          : positionsReady && !ps.length
            ? "0"
            : null;
      const status = !positionsReady
        ? "合约待同步"
        : stable
          ? "稳定币"
          : !hedged
            ? bq.gt(0)
              ? "净空持仓"
              : "未对冲"
            : ratio!.gt(100)
              ? "超额对冲"
              : ratio!.eq(100)
                ? "数量中性"
                : "部分对冲";
      return {
        asset,
        spot: s,
        positions: ps,
        stable,
        hedged,
        spotQuantity: sq.toString(),
        collateralQuantity: collateral.toString(),
        collateralPrice: wallet?.price ?? null,
        collateralWallet: wallet,
        longQuantity: lq.toString(),
        shortQuantity: bq.toString(),
        netQuantity: positionsReady ? net.toString() : null,
        referencePrice: ref,
        longExposure: known ? totalLong.mul(ref!).toString() : null,
        shortExposure: known ? bq.mul(ref!).toString() : null,
        netExposure: known ? net.mul(ref!).toString() : null,
        grossExposure: known ? totalLong.plus(bq).mul(ref!).toString() : null,
        hedgeRatio: ratio?.toString() ?? null,
        hedgedValue: known ? Decimal.min(totalLong, bq).mul(ref!).toString() : null,
        floatingPnl: stable && !ps.length ? null : (floating?.toString() ?? null),
        fundingPnl: funding,
        holdingPnl: stable && !ps.length ? null : (floating?.plus(funding ?? 0).toString() ?? null),
        pnlComplete:
          positionsReady &&
          floating !== null &&
          funding !== null &&
          legacy.every((h) => h.pnlComplete !== false),
        status,
      };
    })
    .sort((a, b) =>
      D(b.grossExposure ?? b.spot?.value ?? 0).cmp(a.grossExposure ?? a.spot?.value ?? 0),
    );
  const risk = groups.filter((g) => !g.stable);
  const complete =
    positionsReady && !unsupported.length && risk.every((g) => g.grossExposure !== null);
  const sum = (key: "longExposure" | "shortExposure" | "netExposure" | "grossExposure") =>
    complete ? risk.reduce((v, g) => v.plus(g[key]!), D(0)).toString() : null;
  const net = sum("netExposure");
  return {
    groups,
    unsupported,
    complete,
    positionsReady,
    long: sum("longExposure"),
    short: sum("shortExposure"),
    net,
    gross: sum("grossExposure"),
    netRatio:
      net !== null && data.summary.equityComplete && D(data.summary.equity).gt(0)
        ? D(net).div(data.summary.equity).mul(100).toString()
        : null,
  };
}
