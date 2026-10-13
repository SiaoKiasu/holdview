export type Source = "demo" | "binance";
export type Balance = { asset: string; free: string; locked: string };
export type Ticker = { symbol: string; lastPrice: string; priceChangePercent: string };
export type Trade = {
  instrument?: "futures";
  realizedPnl?: string;
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
  version: 1;
  markets: Record<string, MarketLedger>;
  feeRates?: Record<string, { price: string | null; checkedAt: number }>;
  futures?: FuturesLedger;
};
export type HistorySync = { scanned: number; total: number; oldestCheck: number | null };
export type ProviderData = {
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
  tradeId?: string;
  tranId: string;
  symbol: string;
  incomeType: string;
  income: string;
  asset: string;
  time: number;
};
export type FuturesPosition = {
  symbol: string;
  positionSide: "BOTH" | "LONG" | "SHORT";
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  marginAsset: string;
};
export type FuturesLedger = {
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
