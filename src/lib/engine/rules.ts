/**
 * Paper-mode economics. These constants used to come from `/api/config`; on a device-only build
 * they live here, and `api.config()` serves them. Everything downstream (engine, UI gating) reads
 * them from this single object, so a "server-side rules change" is still a one-line edit.
 *
 * The pricing model mirrors `blanks-app/src/lib/engine.ts` (the Blanks simulator): a constant-
 * product AMM reconstructed from the pool's liquidity provides real price impact, the user's
 * slippage tolerance is applied on top of the swap, and when liquidity is unknown a flat
 * fallback slippage stands in for it.
 */

export interface PaperConfig {
  paperMode: boolean;
  /** Enables the developer sign-in card (no backend needed to authenticate). */
  devAuth: boolean;
  startingBalance: number;
  minStartingBalance: number;
  maxStartingBalance: number;
  startingBalancePresets: number[];
  /** Platform fee as a fraction (0.005 = 0.5%). The DEX fee is added per token — see DEX_FEES. */
  feeRate: number;
  /**
   * Slippage tolerance for BUYS, in percent. Orders that would fill past it revert. Memecoin
   * venues allow up to ~50%; 0.5% is the sane default for liquid pools.
   */
  slippageBuyPct: number;
  /** Slippage tolerance for SELLS, in percent. */
  slippageSellPct: number;
  /** Hard ceiling for either side's tolerance, in percent, whatever the user configures. */
  slippageCapPct: number;
  /** Slippage applied when the pool's liquidity is unknown ("flat" market), in percent. */
  fallbackSlippagePct: number;
  /**
   * Fixed network fee per trade, in USD (Solana's priority + tip + base ≈ $0.2–0.5). Charged on
   * top of the order, like a real transaction: the percentage fees eat into the swap, this one
   * hits the wallet separately. On a \$10 order it is the difference between 2% and 6% of cost.
   */
  networkFeeUsd: number;
  minTradeUsd: number;
  maxTradeUsd: number;
  minimumAge: number;
  policyVersion: string;
  marketDataProvider: string;
}

export const PAPER_CONFIG: PaperConfig = {
  paperMode: true,
  devAuth: true,
  startingBalance: 10_000,
  // From $1: practising with pocket change is the point, and the fixed network fee
  // ($0.35) teaches its lesson loudest on tiny accounts.
  minStartingBalance: 1,
  maxStartingBalance: 1_000_000,
  startingBalancePresets: [1, 10, 100, 1_000, 5_000, 10_000, 50_000, 100_000],
  feeRate: 0.005,
  slippageBuyPct: 0.5,
  slippageSellPct: 0.5,
  slippageCapPct: 50,
  fallbackSlippagePct: 1.5,
  networkFeeUsd: 0.35,
  // Small enough that a $1 account can still trade (its network fee will dominate —
  // that is the lesson), big enough to keep fat fingers out.
  minTradeUsd: 0.25,
  maxTradeUsd: 100_000,
  minimumAge: 18,
  policyVersion: 'local-3',
  marketDataProvider: 'azura',
};

/** DEX fee as a fraction, by dexId. `_default` covers unknown venues. From the Blanks engine. */
export const DEX_FEES: Readonly<Record<string, number>> = {
  pumpfun: 0.01,
  pumpswap: 0.0025,
  raydium: 0.0025,
  meteora: 0.0025,
  orca: 0.003,
  launchlab: 0.0025,
  believe: 0.01,
  moonshot: 0.01,
  boop: 0.01,
  heaven: 0.01,
  uniswap: 0.003,
  pancakeswap: 0.0025,
  aerodrome: 0.003,
  sushiswap: 0.003,
  flapsh: 0.01,
  fourmeme: 0.01,
  'four.meme': 0.01,
  clanker: 0.01,
  virtuals: 0.01,
  _default: 0.003,
};

export function dexFeeRate(dexId?: string | null): number {
  if (!dexId) return DEX_FEES._default;
  return DEX_FEES[String(dexId).toLowerCase()] ?? DEX_FEES._default;
}

/** Total trading fee for a token: platform + venue. */
export function feeRateFor(cfg: PaperConfig, dexId?: string | null): number {
  return cfg.feeRate + dexFeeRate(dexId);
}

/** Slippage tolerance as a fraction for a side, capped at `slippageCapPct` no matter the setting. */
export function slippageTolerance(cfg: PaperConfig, side: 'BUY' | 'SELL'): number {
  const raw = side === 'BUY' ? cfg.slippageBuyPct : cfg.slippageSellPct;
  const max = Math.max(0, raw) / 100;
  const cap = Math.max(0, cfg.slippageCapPct) / 100;
  return Math.min(max, cap);
}

/**
 * The slippage a fill actually suffers: uniform between 0 and the user's tolerance, the way the
 * market moves between the quote and the block landing (Blanks' 'random' mode). When it pushes
 * the effective price past the tolerance the order reverts instead of filling — exactly what the
 * on-chain `min_amount_out` check does.
 */
export function resolveSlippage(cfg: PaperConfig, side: 'BUY' | 'SELL'): number {
  return Math.random() * slippageTolerance(cfg, side);
}

/** `slippageRate` for `/api/config` — the buy-side fraction the UI's quick math reads. */
export function slippageRateOf(cfg: PaperConfig): number {
  return slippageTolerance(cfg, 'BUY');
}

/** Quantities below this are treated as "position fully sold" (float dust). */
export const DUST_QTY = 1e-9;

/** The engine's rules with user overrides (Settings) layered on top of the built-in defaults. */
export function effectiveConfig(overrides: Partial<PaperConfig> = {}): PaperConfig {
  return { ...PAPER_CONFIG, ...overrides };
}
