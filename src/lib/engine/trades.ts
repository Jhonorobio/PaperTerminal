/**
 * The paper-trading engine — pure arithmetic over plain state. This module replaces the trade
 * handlers the old backend ran; it does no I/O, so it is unit-testable and portable (a future
 * server could import the exact same files).
 *
 * Money conventions (they mirror what `use-trade.ts` computes client-side, so both agree):
 *   BUY  `amountUsd`   fee = amount * feeRate, deducted from the amount; what remains enters the
 *                      pool. Tokens come out of the constant-product AMM when liquidity is known,
 *                      or from price × (1 − fallback) when it is not. The user's slippage
 *                      tolerance (capped at `slippageCapPct`) is then applied on top.
 *   SELL `amountUsd`   tokens → pool (again constant product, or the flat fallback), then
 *                      tolerance slippage, then the fee out of the gross; the net lands in cash.
 *   SELL `percent`     tokens = position qty × percent / 100, then as above (client sends both;
 *                      percent wins, it is the exact instruction).
 *
 * `realizedPnl` is null on buys, a number on sells — the shape `Trade` in `../types` demands.
 */

import type { ClosedTrade, Position, Quote, Side, Trade } from '../types';
import { ApiError } from '../errors';
import { newId } from '../ids';
import {
  DEX_FEES,
  DUST_QTY,
  PAPER_CONFIG,
  dexFeeRate,
  feeRateFor,
  resolveSlippage,
  slippageTolerance,
  type PaperConfig,
} from './rules';
import { buyTokensFromUsd, poolFromLiquidity, sellTokensToUsd } from './amm';

export interface StoredAccount {
  cashBalance: number;
  startingBalance: number;
  startedAt: string;
}

export interface StoredPosition {
  assetId: string;
  chainId: string;
  address: string;
  quantity: number;
  costBasis: number;
  openedAt: string;
  entryMarketCapUsd: number | null;
}

export interface EngineState {
  account: StoredAccount | null;
  positions: StoredPosition[];
  trades: Trade[];
  closed: ClosedTrade[];
}

/** Market data the engine needs for a fill, captured at request time. */
export interface TradeMarketInput {
  priceUsd: number;
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
  symbol?: string | null;
  /** Venue id from the feed ('raydium', 'pumpfun', …) — drives the DEX fee. */
  dex?: string | null;
  /** Effective fee rate (platform + DEX). When absent it is derived from `dex`. */
  feeRate?: number | null;
}

export interface TradeRequest {
  chain: string;
  address: string;
  side: Side;
  clientRequestId: string;
  /** USD notional. Ignored when `percent` is present. */
  amountUsd?: number;
  /** Percent of the position to sell, 0-100. SELL only. */
  percent?: number;
  market: TradeMarketInput;
}

export interface TradeOutcome {
  state: EngineState;
  trade: Trade;
  /** The affected position after the fill; null when a sell closed it. */
  position: Position | null;
}

export const assetIdOf = (chain: string, address: string) => `${chain}:${address}`.toLowerCase();

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const round12 = (n: number) => Math.round(n * 1e12) / 1e12;

function requireAccount(state: EngineState): StoredAccount {
  if (!state.account) {
    throw new ApiError(400, 'ACCOUNT_SETUP_REQUIRED', 'Choose your starting capital first.');
  }
  return state.account;
}

function feeRateOf(market: TradeMarketInput, cfg: PaperConfig): number {
  return market.feeRate && market.feeRate > 0 ? market.feeRate : feeRateFor(cfg, market.dex);
}

/**
 * Applies one fill to the engine state. Throws `ApiError` with the codes screens already handle:
 * `ACCOUNT_SETUP_REQUIRED`, `INSUFFICIENT_CASH`, `INSUFFICIENT_POSITION`, `TRADE_TOO_SMALL`,
 * `TRADE_TOO_LARGE`, `MARKET_DATA_UNAVAILABLE`.
 */
export function executeTrade(state: EngineState, req: TradeRequest, cfg: PaperConfig = PAPER_CONFIG): TradeOutcome {
  const account = requireAccount(state);
  const price = Number(req.market.priceUsd);
  if (!Number.isFinite(price) || price <= 0) {
    throw new ApiError(502, 'MARKET_DATA_UNAVAILABLE', 'No live price for this token.');
  }

  const assetId = assetIdOf(req.chain, req.address);
  const now = new Date();
  const nowIso = now.toISOString();
  const symbol = req.market.symbol ?? null;

  if (req.side === 'BUY') return executeBuy(state, account, req, cfg, { price, assetId, symbol, nowIso });
  return executeSell(state, account, req, cfg, { price, assetId, symbol, now, nowIso });
}

interface BuyCtx {
  price: number;
  assetId: string;
  symbol: string | null;
  nowIso: string;
}

function executeBuy(state: EngineState, account: StoredAccount, req: TradeRequest, cfg: PaperConfig, ctx: BuyCtx): TradeOutcome {
  const amount = Number(req.amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(400, 'INVALID_AMOUNT', 'Enter a USD amount to buy.');
  }
  if (amount < cfg.minTradeUsd) {
    throw new ApiError(400, 'TRADE_TOO_SMALL', `Minimum order is $${cfg.minTradeUsd}.`);
  }
  if (amount > cfg.maxTradeUsd) {
    throw new ApiError(400, 'TRADE_TOO_LARGE', `Maximum order is $${cfg.maxTradeUsd}.`);
  }
  if (amount > account.cashBalance + 1e-6) {
    throw new ApiError(400, 'INSUFFICIENT_CASH', 'Not enough balance.');
  }
  if (amount + cfg.networkFeeUsd > account.cashBalance + 1e-6) {
    throw new ApiError(400, 'INSUFFICIENT_CASH', 'Not enough balance to cover the network fee.');
  }

  const feeRate = feeRateOf(req.market, cfg);
  const fee = round6(amount * feeRate);
  // The percentage fee comes out of the amount you chose to spend — what remains is what enters
  // the pool (output-based, exactly how an on-chain swap quotes it).
  const swapUsd = amount - fee;
  if (!(swapUsd > 0)) {
    throw new ApiError(400, 'TRADE_TOO_SMALL', 'Order too small to cover fees.');
  }

  const pool = poolFromLiquidity(req.market.liquidityUsd, ctx.price);
  const tolerance = slippageTolerance(cfg, 'BUY');
  const fallback = cfg.fallbackSlippagePct / 100;

  let quantity: number;
  let impactPct: number;
  if (pool) {
    const filled = buyTokensFromUsd(pool, swapUsd);
    if (!filled) throw new ApiError(502, 'MARKET_DATA_UNAVAILABLE', 'No live price for this token.');
    quantity = filled.tokens;
    impactPct = filled.impactPct;
  } else {
    // Flat market: no pool to simulate — the fallback slippage stands in for the impact.
    quantity = (swapUsd / ctx.price) * (1 - fallback);
    impactPct = cfg.fallbackSlippagePct;
  }

  // The fill suffers a random slippage within tolerance — the market moving between the quote and
  // the block. If that pushes the effective price past the limit the order REVERTS: it does not
  // fill at a worse price, which is exactly what the on-chain min_amount_out check does. Fees are
  // not part of the limit — they are a known cost, not a price move.
  const slippage = resolveSlippage(cfg, 'BUY');
  quantity = round12(quantity * (1 - slippage));
  const execPrice = amount / quantity;
  const marketMove = pool ? Math.abs(impactPct) / 100 : 0;
  if (marketMove + slippage > tolerance + 1e-12) {
    throw new ApiError(
      400,
      'SLIPPAGE_EXCEEDED',
      `Price moved past your ${(tolerance * 100).toFixed(2)}% buy slippage — the order reverted without filling.`,
    );
  }

  // Effective price per token, fees included — what you actually paid per token.
  const existing = state.positions.find((p) => p.assetId === ctx.assetId);

  const positions = existing
    ? state.positions.map((p) =>
        p.assetId === ctx.assetId
          ? {
              ...p,
              quantity: round12(p.quantity + quantity),
              // Cost basis is everything that left the wallet: the order plus the network fee.
              costBasis: round6(p.costBasis + amount + cfg.networkFeeUsd),
              entryMarketCapUsd: p.entryMarketCapUsd ?? req.market.marketCapUsd ?? null,
            }
          : p,
      )
    : [
        ...state.positions,
        {
          assetId: ctx.assetId,
          chainId: req.chain,
          address: req.address,
          quantity,
          costBasis: round6(amount + cfg.networkFeeUsd),
          openedAt: ctx.nowIso,
          entryMarketCapUsd: req.market.marketCapUsd ?? null,
        },
      ];

  const trade: Trade = {
    id: newId('pt'),
    side: 'BUY',
    symbol: ctx.symbol ?? undefined,
    chainId: req.chain,
    address: req.address,
    assetId: ctx.assetId,
    quantity,
    executionPrice: execPrice,
    marketPrice: ctx.price,
    requestedValue: amount,
    fee: round6(fee + cfg.networkFeeUsd),
    slippage: slippage,
    impactPct: round2(impactPct),
    cashAfter: round6(account.cashBalance - amount - cfg.networkFeeUsd),
    liquidityUsd: req.market.liquidityUsd ?? null,
    marketCapUsd: req.market.marketCapUsd ?? null,
    status: 'open',
    timestamp: ctx.nowIso,
    realizedPnl: null,
    closesPosition: false,
  };

  const nextAccount: StoredAccount = { ...account, cashBalance: round6(account.cashBalance - amount - cfg.networkFeeUsd) };
  const stored = positions.find((p) => p.assetId === ctx.assetId)!;

  return {
    state: { ...state, account: nextAccount, positions, trades: [...state.trades, trade] },
    trade,
    position: toPosition(stored, ctx.price, req.market.marketCapUsd ?? null, ctx.symbol),
  };
}

interface SellCtx {
  price: number;
  assetId: string;
  symbol: string | null;
  now: Date;
  nowIso: string;
}

function executeSell(state: EngineState, account: StoredAccount, req: TradeRequest, cfg: PaperConfig, ctx: SellCtx): TradeOutcome {
  const position = state.positions.find((p) => p.assetId === ctx.assetId);
  if (!position || position.quantity <= 0) {
    throw new ApiError(400, 'INSUFFICIENT_POSITION', `No ${ctx.symbol ?? 'token'} to sell.`);
  }

  // SELL can be "this many USD" or "this percent of the position". Percent is the exact
  // instruction and wins when both are present (the client computes the USD amount from the same
  // quote, so they agree anyway).
  let quantity: number;
  if (req.percent !== undefined && req.percent !== null) {
    const pct = Number(req.percent);
    if (!Number.isFinite(pct) || pct <= 0) {
      throw new ApiError(400, 'INVALID_AMOUNT', 'Enter a percent to sell.');
    }
    if (pct > 100) {
      throw new ApiError(400, 'INVALID_AMOUNT', 'Percent cannot exceed 100.');
    }
    quantity = round12((position.quantity * Math.min(pct, 100)) / 100);
  } else {
    const amount = Number(req.amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError(400, 'INVALID_AMOUNT', 'Enter a USD amount to sell.');
    }
    // Undo the pessimistic path (fallback − tolerance) to translate USD into tokens when the
    // market is flat; with a pool the amount in already accounts for the impact it causes.
    const pool = poolFromLiquidity(req.market.liquidityUsd, ctx.price);
    if (pool) {
      quantity = amount / (ctx.price * (1 - slippageTolerance(cfg, 'SELL')));
    } else {
      const pessimistic = ctx.price * (1 - cfg.fallbackSlippagePct / 100) * (1 - slippageTolerance(cfg, 'SELL'));
      quantity = amount / pessimistic;
    }
    quantity = round12(quantity);
  }

  if (quantity > position.quantity * (1 + 1e-9)) {
    throw new ApiError(400, 'INSUFFICIENT_POSITION', `Not enough ${ctx.symbol ?? 'token'}.`);
  }

  const closes = quantity >= position.quantity * (1 - DUST_QTY) || req.percent === 100;
  if (closes) quantity = position.quantity;

  const pool = poolFromLiquidity(req.market.liquidityUsd, ctx.price);
  const tolerance = slippageTolerance(cfg, 'SELL');
  const fallback = cfg.fallbackSlippagePct / 100;

  let grossUsd: number;
  let impactPct: number;
  let poolKnown: boolean;
  if (pool) {
    const filled = sellTokensToUsd(pool, quantity);
    if (!filled) throw new ApiError(502, 'MARKET_DATA_UNAVAILABLE', 'No live price for this token.');
    grossUsd = filled.execPriceUsd * quantity;
    impactPct = filled.impactPct;
    poolKnown = true;
  } else {
    grossUsd = quantity * ctx.price * (1 - fallback);
    impactPct = -cfg.fallbackSlippagePct;
    poolKnown = false;
  }
  // Random slippage within tolerance; past the limit the order reverts instead of filling worse.
  const slippage = resolveSlippage(cfg, 'SELL');
  grossUsd = round6(grossUsd * (1 - slippage));

  const marketMove = pool ? Math.abs(impactPct) / 100 : 0;
  if (marketMove + slippage > tolerance + 1e-12) {
    throw new ApiError(
      400,
      'SLIPPAGE_EXCEEDED',
      `Price moved past your ${(tolerance * 100).toFixed(2)}% sell slippage — the order reverted without filling.`,
    );
  }

  const feeRate = feeRateOf(req.market, cfg);
  const fee = round6(grossUsd * feeRate);
  // The percentage fee eats the swap's output; the network fee comes out of what lands in cash.
  const proceeds = round6(grossUsd - fee - cfg.networkFeeUsd);
  const costConsumed = round6((position.costBasis * quantity) / position.quantity);
  const realized = round6(proceeds - costConsumed);
  const execPrice = proceeds / quantity;

  const positions = closes
    ? state.positions.filter((p) => p.assetId !== ctx.assetId)
    : state.positions.map((p) =>
        p.assetId === ctx.assetId
          ? { ...p, quantity: round12(p.quantity - quantity), costBasis: round6(p.costBasis - costConsumed) }
          : p,
      );

  const trade: Trade = {
    id: newId('pt'),
    side: 'SELL',
    symbol: ctx.symbol ?? undefined,
    chainId: req.chain,
    address: req.address,
    assetId: ctx.assetId,
    quantity,
    executionPrice: execPrice,
    marketPrice: ctx.price,
    requestedValue: round6(grossUsd / (1 - slippage)),
    fee: round6(fee + cfg.networkFeeUsd),
    slippage,
    impactPct: round2(impactPct),
    cashAfter: round6(account.cashBalance + proceeds),
    liquidityUsd: req.market.liquidityUsd ?? null,
    marketCapUsd: req.market.marketCapUsd ?? null,
    status: closes ? 'closed' : 'open',
    timestamp: ctx.nowIso,
    realizedPnl: realized,
    closesPosition: closes,
  };

  const nextAccount: StoredAccount = { ...account, cashBalance: round6(account.cashBalance + proceeds) };

  let closed = state.closed;
  if (closes) {
    closed = [
      ...state.closed,
      buildClosedTrade(state, position, req.chain, req.address, ctx, {
        quantity,
        execPrice,
        amountUsd: grossUsd / (1 - slippage),
        fee,
        proceeds,
        costConsumed,
        realized,
        poolKnown,
      }),
    ];
  }

  const remaining = closes ? null : positions.find((p) => p.assetId === ctx.assetId)!;

  return {
    state: { ...state, account: nextAccount, positions, trades: [...state.trades, trade], closed },
    trade,
    position: remaining ? toPosition(remaining, ctx.price, req.market.marketCapUsd ?? null, ctx.symbol) : null,
  };
}

interface ClosedInputs {
  quantity: number;
  execPrice: number;
  amountUsd: number;
  fee: number;
  proceeds: number;
  costConsumed: number;
  realized: number;
  poolKnown: boolean;
}

function buildClosedTrade(
  state: EngineState,
  position: StoredPosition,
  chain: string,
  address: string,
  ctx: SellCtx,
  fill: ClosedInputs,
): ClosedTrade {
  const assetTrades = state.trades.filter((t) => t.assetId === position.assetId);
  const entryTime = position.openedAt;
  const holdMs = Math.max(0, ctx.now.getTime() - new Date(entryTime).getTime());
  const returnPct = fill.costConsumed > 0 ? (fill.realized / fill.costConsumed) * 100 : 0;

  return {
    id: newId('ct'),
    assetId: position.assetId,
    chainId: chain,
    address,
    symbol: ctx.symbol ?? undefined,
    entryPrice: position.quantity > 0 ? position.costBasis / position.quantity : fill.execPrice,
    exitPrice: fill.execPrice,
    entryMarketCapUsd: position.entryMarketCapUsd,
    exitMarketCapUsd: null,
    positionSizeUsd: fill.costConsumed,
    proceedsUsd: fill.proceeds,
    fees: fill.fee,
    realizedPnl: fill.realized,
    returnPct,
    buyCount: assetTrades.filter((t) => t.side === 'BUY').length,
    sellCount: assetTrades.filter((t) => t.side === 'SELL').length + 1,
    holdMs,
    entryTime,
    exitTime: ctx.nowIso,
  };
}

/** Stored row → the enriched `Position` the screens read (priced at the provided quote). */
export function toPosition(p: StoredPosition, price: number | null, marketCapUsd: number | null, symbol?: string | null): Position {
  const quantity = p.quantity;
  const marketValue = price != null ? quantity * price : null;
  const unrealizedPnl = marketValue != null ? round6(marketValue - p.costBasis) : 0;
  const averageEntryPrice = quantity > 0 ? p.costBasis / quantity : null;
  return {
    assetId: p.assetId,
    chainId: p.chainId,
    address: p.address,
    symbol: symbol ?? undefined,
    quantity,
    marketValue: marketValue != null ? round6(marketValue) : null,
    costBasis: p.costBasis,
    unrealizedPnl,
    unrealizedPnlPct: p.costBasis > 0 ? (unrealizedPnl / p.costBasis) * 100 : null,
    averageEntryPrice,
    entryMarketCapUsd: p.entryMarketCapUsd,
    currentPrice: price,
    marketCapUsd,
    openedAt: p.openedAt,
  };
}

/** Convenience used by the "sell everything" action. */
export function closePositionTrade(state: EngineState, req: Omit<TradeRequest, 'side' | 'percent'>, cfg: PaperConfig = PAPER_CONFIG): TradeOutcome {
  return executeTrade(state, { ...req, side: 'SELL', percent: 100 }, cfg);
}

/** Quote → the engine's market input. */
export function marketInputFromQuote(quote: Quote): TradeMarketInput {
  return {
    priceUsd: quote.priceUsd,
    liquidityUsd: quote.liquidityUsd ?? null,
    marketCapUsd: quote.marketCapUsd ?? null,
    symbol: quote.symbol ?? null,
    dex: quote.dex ?? null,
    feeRate: quote.feeRate ?? null,
  };
}

// ─── previews ───────────────────────────────────────────────────────────────

export interface OrderPreview {
  side: Side;
  quantity: number;
  /** Effective USD price per token, percentage fees included. */
  execPriceUsd: number;
  marketPriceUsd: number;
  /** Percentage fee (platform + venue) as USD. */
  feeUsd: number;
  /** Fixed network fee charged on top of the order, in USD. */
  networkFeeUsd: number;
  /** Positive percentage on buys, negative on sells — how far the fill lands from mid. */
  impactPct: number;
  /** The expected slippage for this fill (half the tolerance — slippage draws uniformly). */
  slippagePct: number;
  /** Chance the order reverts instead of filling, 0–100. */
  revertRiskPct: number;
  /** True when the pool impact alone already exceeds the tolerance — the order can never fill. */
  revertsAlways: boolean;
  /** False when the pool's liquidity is unknown and the fallback slippage stands in. */
  poolKnown: boolean;
  /** Total that leaves the wallet on a buy; net that lands on a sell. In USD. */
  totalUsd: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Chance a fill reverts given the market's move so far: the drawn slippage has to stay inside
 * `tolerance − marketMove`, so the risk is whatever fraction of the tolerance is already spent.
 */
function revertRiskOf(marketMove: number, tolerance: number): number {
  if (tolerance <= 0) return 1;
  if (marketMove >= tolerance) return 1;
  return (tolerance - marketMove) / tolerance;
}

/**
 * Same math as a fill, minus the state: what the trade panel shows before confirming. Returns
 * null when the inputs cannot produce an order (no amount, zero position). Slippage here is the
 * *expected* draw (half the tolerance), while `revertRiskPct` tells you how often this exact order
 * would bounce instead of filling.
 */
export function previewOrder(
  input: { side: Side; amountUsd?: number; percent?: number; positionQuantity?: number | null; market: TradeMarketInput },
  cfg: PaperConfig = PAPER_CONFIG,
): OrderPreview | null {
  const price = Number(input.market.priceUsd);
  if (!Number.isFinite(price) || price <= 0) return null;

  const pool = poolFromLiquidity(input.market.liquidityUsd, price);
  const tolerance = slippageTolerance(cfg, input.side);
  const expectedSlippage = tolerance / 2;
  const fallback = cfg.fallbackSlippagePct / 100;
  const feeRate = feeRateOf(input.market, cfg);

  if (input.side === 'BUY') {
    const amount = Number(input.amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const fee = amount * feeRate;
    const swapUsd = amount - fee;
    if (!(swapUsd > 0)) return null;

    let tokens: number;
    let impactPct: number;
    if (pool) {
      const filled = buyTokensFromUsd(pool, swapUsd);
      if (!filled) return null;
      tokens = filled.tokens;
      impactPct = filled.impactPct;
    } else {
      tokens = (swapUsd / price) * (1 - fallback);
      impactPct = cfg.fallbackSlippagePct;
    }
    tokens *= 1 - expectedSlippage;
    const risk = revertRiskOf(pool ? Math.abs(impactPct) / 100 : 0, tolerance);
    return {
      side: 'BUY',
      quantity: tokens,
      execPriceUsd: amount / tokens,
      marketPriceUsd: price,
      feeUsd: fee,
      networkFeeUsd: cfg.networkFeeUsd,
      impactPct: round2(impactPct),
      slippagePct: round2(expectedSlippage * 100),
      revertRiskPct: round2(risk * 100),
      revertsAlways: risk >= 1,
      poolKnown: Boolean(pool),
      totalUsd: amount + cfg.networkFeeUsd,
    };
  }

  // SELL
  const posQty = Number(input.positionQuantity ?? 0);
  if (!(posQty > 0)) return null;
  let tokens: number;
  if (input.percent != null) {
    const pct = Number(input.percent);
    if (!Number.isFinite(pct) || pct <= 0) return null;
    tokens = (posQty * Math.min(pct, 100)) / 100;
  } else {
    const amount = Number(input.amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (pool) {
      tokens = amount / (price * (1 - expectedSlippage));
    } else {
      tokens = amount / (price * (1 - fallback) * (1 - expectedSlippage));
    }
  }
  if (tokens > posQty * (1 + 1e-9)) return null;

  let grossUsd: number;
  let impactPct: number;
  if (pool) {
    const filled = sellTokensToUsd(pool, tokens);
    if (!filled) return null;
    grossUsd = filled.execPriceUsd * tokens;
    impactPct = filled.impactPct;
  } else {
    grossUsd = tokens * price * (1 - fallback);
    impactPct = -cfg.fallbackSlippagePct;
  }
  grossUsd *= 1 - expectedSlippage;
  const fee = grossUsd * feeRate;
  const proceeds = grossUsd - fee - cfg.networkFeeUsd;
  const risk = revertRiskOf(pool ? Math.abs(impactPct) / 100 : 0, tolerance);

  return {
    side: 'SELL',
    quantity: tokens,
    execPriceUsd: proceeds / tokens,
    marketPriceUsd: price,
    feeUsd: fee,
    networkFeeUsd: cfg.networkFeeUsd,
    impactPct: round2(impactPct),
    slippagePct: round2(expectedSlippage * 100),
    revertRiskPct: round2(risk * 100),
    revertsAlways: risk >= 1,
    poolKnown: Boolean(pool),
    totalUsd: proceeds,
  };
}

export { DEX_FEES, dexFeeRate, feeRateFor, resolveSlippage, slippageTolerance };
