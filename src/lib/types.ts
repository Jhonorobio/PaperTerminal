// Shapes of the paper-trading server's responses, inferred from the extension's usage.
// Fields the extension never touches are left out; fields it only ever reads with `?.` are
// optional, so a server that omits one cannot crash a screen.

export type Side = 'BUY' | 'SELL';

export interface Asset {
  chain: string;
  address: string;
  symbol: string | null;
  source?: 'url' | 'manual';
}

export interface SessionUser {
  email?: string;
  displayName?: string;
  photoUrl?: string | null;
}

export interface Session {
  token: string;
  user: SessionUser;
}

export interface Quote {
  chainId?: string;
  address?: string;
  symbol?: string;
  name?: string;
  imageUrl?: string | null;
  priceUsd: number;
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
  change24hPct?: number | null;
  source?: string;
  assetId?: string;
  fetchedAt?: string;
  ageMs?: number;
}

export interface Account {
  cashBalance: number;
  startingBalance?: number;
}

export interface Position {
  assetId: string;
  chainId?: string;
  address?: string;
  symbol?: string;
  quantity: number;
  marketValue?: number | null;
  costBasis: number;
  unrealizedPnl: number;
  unrealizedPnlPct?: number | null;
  averageEntryPrice?: number | null;
  entryMarketCapUsd?: number | null;
  currentPrice?: number | null;
  marketCapUsd?: number | null;
  openedAt?: string;
}

export interface ClosedTrade {
  id: string;
  assetId: string;
  chainId?: string;
  address?: string;
  symbol?: string;
  entryPrice?: number;
  exitPrice?: number;
  entryMarketCapUsd?: number | null;
  exitMarketCapUsd?: number | null;
  positionSizeUsd?: number;
  proceedsUsd?: number;
  fees?: number;
  realizedPnl: number;
  returnPct: number;
  buyCount?: number;
  sellCount?: number;
  holdMs?: number;
  entryTime?: string;
  exitTime?: string;
}

export interface Trade {
  id: string;
  side: Side;
  symbol?: string;
  chainId?: string;
  address?: string;
  assetId?: string;
  quantity: number;
  executionPrice: number;
  marketPrice?: number;
  requestedValue?: number;
  fee?: number;
  slippage?: number;
  cashAfter?: number;
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
  status?: 'open' | 'closed';
  timestamp: string;
  realizedPnl: number | null;
  total?: number;
  closesPosition?: boolean;
}

export interface BestTrade {
  symbol?: string;
  realizedPnl: number;
}

export interface Performance {
  cash?: number;
  invested?: number;
  marketValue?: number;
  totalEquity: number;
  totalPnl: number;
  totalPnlPct?: number;
  startingBalance?: number;
  todayPnl?: number;
  unrealizedPnl?: number;
  winRate: number | null;
  wins?: number;
  losses?: number;
  tradeCount?: number;
  buyCount?: number;
  sellCount?: number;
  openPositionCount?: number;
  bestTrade?: BestTrade | null;
}

export interface TradingStyle {
  sampleSize: number;
  style?: string;
  styleDescription?: string;
  medianHoldMs?: number;
  winRatePct?: number | null;
  profitFactor?: number | null;
  expectancyUsd?: number | null;
  averageWinUsd?: number | null;
  averageLossUsd?: number | null;
  averageBuySizeUsd?: number | null;
  averageBuyPctOfCash?: number | null;
  maxRealizedDrawdownPct?: number | null;
  longestWinningRun?: number;
  personalBests?: { bestReturnPct?: number | null };
  activityByHourUtc?: number[];
  insights?: string[];
}

export interface Portfolio {
  account?: Account;
  performance: Performance;
  positions: Position[];
  tradingStyle?: TradingStyle;
}

export interface ServerConfig {
  paperMode?: boolean;
  googleClientId?: string;
  devAuth?: boolean;
  startingBalance?: number;
  minStartingBalance?: number;
  maxStartingBalance?: number;
  startingBalancePresets?: number[];
  feeRate?: number;
  slippageRate?: number;
  minTradeUsd?: number;
  maxTradeUsd?: number;
  minimumAge?: number;
  policyVersion?: string;
  marketDataProvider?: string;
}

export interface Me {
  user?: SessionUser | null;
  account?: Account | null;
  needsSetup?: boolean;
  needsConsent?: boolean;
}

export interface ExportedFile {
  text: string;
  contentType: string;
  filename: string;
}
