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
  /** Venue the price comes from ('raydium', 'pumpfun', …). Drives the simulated DEX fee. */
  dex?: string | null;
  /** Effective trading fee for this token (platform + venue), as a fraction. */
  feeRate?: number | null;
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
  /** How far the fill landed from mid, as a percentage (positive = worse price than mid). */
  impactPct?: number | null;
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
  /** Slippage tolerance as a fraction (0.005 = 0.5%), capped by the engine. Buy side. */
  slippageRate?: number;
  /** Buy-side slippage tolerance in percent. Orders past it revert without filling. */
  slippageBuyPct?: number;
  /** Sell-side slippage tolerance in percent. */
  slippageSellPct?: number;
  minTradeUsd?: number;
  maxTradeUsd?: number;
  /** Hard ceiling for slippage tolerance, in percent. */
  slippageCapPct?: number;
  /** Slippage applied when pool liquidity is unknown, in percent. */
  fallbackSlippagePct?: number;
  /** Fixed network fee per trade, in USD, charged on top of the order. */
  networkFeeUsd?: number;
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

// ---------- Photon memescope (via the local APIS server) ----------

export type PhotonColumn = 'col1' | 'col3';

/** One token in a Photon memescope column. */
export interface PhotonToken {
  address: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  mcap: number | null;
  /** All-time high FDV from Photon — the anchor for the row's gain/loss %. */
  ath: number | null;
  liquidity: number | null;
  volume24h: number | null;
  buysCount: number | null;
  holdersCount: number | null;
  tpHoldersCount: number | null;
  freshPct: number | null;
  bundleHolders: number | null;
  bundlePct: number | null;
  topHoldersPct: number | null;
}

export interface PhotonRange {
  min?: number;
  max?: number;
}

/** Per-column filter set — mirrors the server's FILTER_FIELDS. */
export interface PhotonFilters {
  age?: PhotonRange;
  holders?: PhotonRange;
  tpHolders?: PhotonRange;
  mktCap?: PhotonRange;
  buys?: PhotonRange;
  freshPct?: PhotonRange;
  bundleHolders?: PhotonRange;
  bundlePct?: PhotonRange;
  /** % of supply held by the top holders — same as every other field: Photon applies it in the query. */
  topHolders?: PhotonRange;
}

/** One column of the server's memescope payload. */
export interface PhotonColumnData {
  data?: { attributes?: Record<string, unknown> }[];
}

export interface PhotonSnapshot {
  columns: Record<PhotonColumn, PhotonColumnData>;
  titles: Record<string, string>;
  cached?: boolean;
  ageMs: number;
  savedAt?: number;
  error?: string | null;
}

// ---------- FOMO feed (fomo.family) ----------

export type FomoFeedId = 'graduated' | 'trending';

/** One token in a FOMO feed, normalized from the WSS payload. */
export interface FomoToken {
  address: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  /** Launchpad the token graduated from ('pumpfun', 'believe', …). */
  launchpad: string | null;
  /** Creation time, unix seconds. Trending items resolve it via Pulse on demand. */
  createdAt: number | null;
  mcap: number | null;
  price: number | null;
  vol24: number | null;
  change24: number | null;
  holders: number | null;
  /** Trending rank (position in the feed); undefined on graduated. */
  rank?: number;
  /** KOL count, enriched via Pulse only when a KOL filter asks for it. */
  kolCount?: number | null;
  /** Local arrival time of the last update. */
  updatedAt: number;
}

/** Feed filters, mirroring the server's: every bound is optional. */
export interface FomoFilters {
  /** Age window in minutes. */
  ageMinMin?: number;
  ageMaxMin?: number;
  /** Market cap window in USD. */
  mcapMin?: number;
  mcapMax?: number;
  /** KOL count window. */
  kolMin?: number;
  kolMax?: number;
  /** Cap on results (default 200, hard max 1000). */
  limit?: number;
}

export interface FomoStatus {
  connected: boolean;
  authenticated: boolean;
  /** Per-feed liveness: subscribed and receiving. */
  live: boolean;
  /** Data messages per second arriving from FOMO, over a 5s window. */
  updatesPerSec: number;
  graduatedCount: number;
  trendingCount: number;
  lastError: string | null;
  hasRefreshToken: boolean;
}
