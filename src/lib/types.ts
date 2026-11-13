export type Source = "demo" | "binance";
export type Balance = { asset: string; free: string; locked: string };
export type Ticker = { symbol: string; lastPrice: string; priceChangePercent: string };
export type Trade = {
  contractMarket?: "coin";
  baseAsset?: string;
  contractSize?: string;
  realizedPnlAsset?: string;
  instrument?: "futures";
  realizedPnl?: string;
  positionSide?: "BOTH" | "LONG" | "SHORT";
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  price: string;
  quantity: string;
  quoteQuantity: string;
  fee: string;
  feeAsset: string;
  time: number;
  isMaker: boolean;
};
export type Order = {
  contractMarket?: "coin";
  contractSize?: string;
  instrument?: "futures";
  baseAsset?: string;
  quoteAsset?: string;
  executedQuote?: string;
  stopPrice?: string;
  reduceOnly?: boolean;
  closePosition?: boolean;
  positionSide?: "BOTH" | "LONG" | "SHORT";
  orderListId?: string;
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  price: string;
  quantity: string;
  executedQuantity: string;
  status: string;
  time: number;
};
export type Holding = Balance & {
  instrument?: "futures";
  symbol?: string;
  direction?: "多" | "空" | "双向" | "已平仓";
  fundingPnl?: string | null;
  pnlComplete?: boolean;
  returnRate?: string | null;
  quantity: string;
  price: string | null;
  value: string | null;
  allocation: number;
  change24h: number | null;
  averageCost: string | null;
  unrealizedPnl: string | null;
};
export type Snapshot = { time: number; equity: string };
export type MarketLedger = {
  baseAsset: string;
  quoteAsset: string;
  nextId: string;
  complete: boolean;
  checkedAt: number;
  trades: Trade[];
};
export type TradeLedger = {
  hedgeAnchors?: Record<string, import("./hedge-tracking").HedgeAnchor>;
  version: 1;
  markets: Record<string, MarketLedger>;
  feeRates?: Record<string, { price: string | null; checkedAt: number }>;
  futures?: FuturesLedger;
  coinFutures?: FuturesLedger;
};
export type HistorySync = { scanned: number; total: number; oldestCheck: number | null };
export type ProviderData = {
  hedgePeriods?: Record<string, import("./hedge-tracking").HedgePeriod>;
  futures?: FuturesData;
  spotEquity?: string | null;
  ledger?: TradeLedger;
  historySync?: HistorySync;

  balances: Balance[];
  tickers: Ticker[];
  trades: Trade[];
  orders: Order[];
  warnings: string[];
  tradesComplete: boolean;
  ordersComplete: boolean;
};
export type Dashboard = {
  marketUpdatedAt?: number;
  marketComplete?: boolean;
  positionDetails?: FuturesPosition[];
  coinWallets?: CoinWallet[];
  hedgePeriods?: Record<string, import("./hedge-tracking").HedgePeriod>;
  closedReview: import("./closed-review").ClosedReview;
  source: Source;
  accountLabel: string;
  environment: string;
  updatedAt: number;
  holdings: Holding[];
  trades: Trade[];
  orders: Order[];
  history: Snapshot[];
  summary: {
    futuresEquity?: string | null;
    futuresAvailable?: string | null;
    futuresInitialMargin?: string | null;
    holdingPnlComplete?: boolean;
    futuresFundingPnl?: string | null;
    equity: string;
    equitySource: "exchange" | "calculated";
    equityComplete: boolean;
    pricedAssets: number;
    unpricedAssets: number;
    unrealizedPnl: string | null;
    costCoverage: number;
    totalPnl: string | null;
    realizedPnl: string | null;
    realizedPnlComplete: boolean;
    feePnl: string | null;
    realizedPnlNote: string;
    principal: string | null;
    cash: string;
    cashFree: string;
    cashLocked: string;
    baseline: string | null;
    baselineAt: string | null;
    netFlows: string | null;
    stablecoinValue: string;
    tradeCount: number;
  };
  connection: {
    futuresEnabled?: boolean;
    futuresComplete?: boolean;
    futuresTradesComplete?: boolean;
    futuresPositionsComplete?: boolean;
    futuresHistoryStart?: number | null;
    historySync: HistorySync;
    database: boolean;
    snapshotsSaved: boolean;
    symbols: string[];
    tradesComplete: boolean;
    ordersComplete: boolean;
  };
  warnings: string[];
};

export type FuturesIncome = {
  contractMarket?: "coin";
  tradeId?: string;
  tranId: string;
  symbol: string;
  incomeType: string;
  income: string;
  asset: string;
  time: number;
};
export type CoinWallet = {
  averageCost?: string | null;
  holdingPnl?: string | null;
  asset: string;
  walletBalance: string;
  marginBalance: string;
  unrealizedProfit: string;
  availableBalance: string;
  initialMargin: string;
  price: string;
};
export type FuturesPosition = {
  // For inverse contracts positionAmt is base-equivalent quantity at mark; financial
  // fields below are USDT. Native units remain here for display and repricing.
  contractMarket?: "coin";
  baseAsset?: string;
  contractType?: string;
  contracts?: string;
  contractSize?: string;
  nativeUnrealizedPnl?: string;
  settlementPrice?: string;
  liquidationPrice?: string;
  initialMargin?: string;
  maintMargin?: string;
  isolatedWallet?: string;
  marginType?: "isolated" | "cross";
  symbol: string;
  positionSide: "BOTH" | "LONG" | "SHORT";
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  marginAsset: string;
};
export type FuturesLedger = {
  incomeWindows?: { startTime: number; endTime: number }[];
  trades?: Trade[];
  tradeSync?: Record<
    string,
    { nextId: string; startTime: number; endTime: number; complete: boolean }
  >;
  incomes: FuturesIncome[];
  startTime: number;
  syncedThrough: number;
  historyGap?: boolean;
  pending?: { startTime: number; endTime: number; page: number };
  feeRates: Record<string, string>;
};
export type FuturesData = {
  coinWallets?: CoinWallet[];
  orders?: Order[];
  ordersComplete?: boolean;
  account?: {
    equity: string;
    walletBalance: string;
    availableBalance: string;
    initialMargin: string;
  };
  positionsComplete?: boolean;
  trades?: Trade[];
  tradesComplete?: boolean;
  positions: FuturesPosition[];
  ledger: FuturesLedger;
  complete: boolean;
  warnings: string[];
};
