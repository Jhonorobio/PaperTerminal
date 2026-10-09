/**
 * Constant-product AMM, reconstructed from the pool's reported liquidity — the model the Blanks
 * simulator uses, and the piece that makes a big order actually move the price.
 *
 * A pool reports its total liquidity in USD; an AMM holds it split evenly between both sides, so
 * from `(liquidityUsd, price)` the reserves follow directly:
 *
 *   reserveQuote = liquidity / 2            (USD side)
 *   reserveBase  = reserveQuote / price      (token side)
 *   k            = reserveQuote * reserveBase
 *
 * and a swap of `x` into the USD side yields `reserveBase - k / (reserveQuote + x)` tokens. The
 * effective price worsens with size exactly as it does on-chain. Everything works in USD, so no
 * native-price conversion is needed.
 *
 * When the feed reports no liquidity the market is "flat": there is no pool to simulate, and the
 * caller substitutes a fixed fallback slippage instead (see rules.ts).
 */

export interface Pool {
  reserveQuoteUsd: number;
  reserveBase: number;
  k: number;
  /** Mid price implied by the reserves (USD per token). */
  midPriceUsd: number;
}

export function poolFromLiquidity(liquidityUsd: number | null | undefined, priceUsd: number): Pool | null {
  if (!liquidityUsd || !(liquidityUsd > 0) || !(priceUsd > 0)) return null;
  const reserveQuoteUsd = liquidityUsd / 2;
  const reserveBase = reserveQuoteUsd / priceUsd;
  return { reserveQuoteUsd, reserveBase, k: reserveQuoteUsd * reserveBase, midPriceUsd: priceUsd };
}

/** How much worse the effective price came out versus mid, as a positive percentage. */
const impactOf = (execPriceUsd: number, midPriceUsd: number) => (midPriceUsd > 0 ? ((execPriceUsd - midPriceUsd) / midPriceUsd) * 100 : 0);

export interface SwapInResult {
  /** Tokens out of the pool. */
  tokens: number;
  /** Effective USD price per token (swapUsd / tokens), impact included. */
  execPriceUsd: number;
  /** Positive percentage: how much worse this fill was versus mid. */
  impactPct: number;
}

/** Buy `swapUsd` worth of tokens from the pool. */
export function buyTokensFromUsd(pool: Pool, swapUsd: number): SwapInResult | null {
  if (!(swapUsd > 0)) return null;
  const tokens = pool.reserveBase - pool.k / (pool.reserveQuoteUsd + swapUsd);
  if (!(tokens > 0) || !Number.isFinite(tokens)) return null;
  const execPriceUsd = swapUsd / tokens;
  return { tokens, execPriceUsd, impactPct: impactOf(execPriceUsd, pool.midPriceUsd) };
}

/** Sell `tokens` into the pool; returns gross USD before fees. */
export function sellTokensToUsd(pool: Pool, tokens: number): SwapInResult | null {
  if (!(tokens > 0)) return null;
  const grossUsd = pool.reserveQuoteUsd - pool.k / (pool.reserveBase + tokens);
  if (!(grossUsd > 0) || !Number.isFinite(grossUsd)) return null;
  const execPriceUsd = grossUsd / tokens;
  // Sells execute BELOW mid, so the impact reads negative (a worse price, not a better one).
  return { tokens, execPriceUsd, impactPct: impactOf(execPriceUsd, pool.midPriceUsd) };
}
