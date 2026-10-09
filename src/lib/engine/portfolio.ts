/**
 * Portfolio math — positions valued at live prices plus the performance card. Pure functions over
 * engine state; the price resolver is injected so this file never imports the market feed (keeps
 * the engine portable).
 */

import type { Performance, Portfolio, Trade } from '../types';
import type { EngineState, StoredPosition } from './trades';
import { toPosition } from './trades';

/** What the caller knows about a token's current price. */
export interface PricePoint {
  priceUsd: number | null;
  marketCapUsd: number | null;
  symbol?: string | null;
}

export type PriceResolver = (assetId: string) => PricePoint | null;

/** Epoch ms of local midnight, given the device's UTC offset in minutes (Date.getTimezoneOffset). */
export function startOfLocalDay(nowMs: number, tzOffsetMinutes: number): number {
  const shifted = nowMs - tzOffsetMinutes * 60_000;
  const day = Math.floor(shifted / 86_400_000);
  return day * 86_400_000 + tzOffsetMinutes * 60_000;
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

function median(ns: number[]): number | null {
  if (!ns.length) return null;
  const s = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface PortfolioInput {
  state: EngineState;
  prices: PriceResolver;
  tzOffsetMinutes: number;
  nowMs?: number;
}

export function computePerformance({ state, prices, tzOffsetMinutes, nowMs = Date.now() }: PortfolioInput): Performance & { positions: Portfolio['positions'] } {
  const account = state.account;
  const startingBalance = account?.startingBalance ?? 0;

  const enriched = state.positions.map((p) => {
    const point = prices(p.assetId);
    return toPosition(p, point?.priceUsd ?? null, point?.marketCapUsd ?? null, point?.symbol ?? null);
  });

  const cash = account?.cashBalance ?? 0;
  const invested = sum(enriched.map((p) => p.costBasis));
  const marketValue = sum(enriched.map((p) => (p.marketValue ?? p.costBasis)));
  const totalEquity = cash + marketValue;
  const unrealizedPnl = marketValue - invested;

  const realizedToday = sum(
    state.trades.filter((t) => t.realizedPnl != null && new Date(t.timestamp).getTime() >= startOfLocalDay(nowMs, tzOffsetMinutes)).map((t) => t.realizedPnl as number),
  );

  const closed = state.closed;
  const wins = closed.filter((t) => t.realizedPnl > 0);
  const losses = closed.filter((t) => t.realizedPnl <= 0);
  const best = closed.length ? closed.reduce((a, b) => (b.realizedPnl > a.realizedPnl ? b : a)) : null;

  return {
    positions: enriched,
    cash,
    invested,
    marketValue,
    totalEquity,
    totalPnl: totalEquity - startingBalance,
    totalPnlPct: startingBalance > 0 ? ((totalEquity - startingBalance) / startingBalance) * 100 : undefined,
    startingBalance,
    todayPnl: realizedToday,
    unrealizedPnl,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    wins: wins.length,
    losses: losses.length,
    tradeCount: state.trades.length,
    buyCount: state.trades.filter((t) => t.side === 'BUY').length,
    sellCount: state.trades.filter((t) => t.side === 'SELL').length,
    openPositionCount: enriched.length,
    bestTrade: best ? { symbol: best.symbol ?? undefined, realizedPnl: best.realizedPnl } : null,
  };
}

export function computePortfolio(input: PortfolioInput): Portfolio {
  const account = input.state.account;
  const { positions, ...performance } = computePerformance(input);
  return {
    account: account ? { cashBalance: account.cashBalance, startingBalance: account.startingBalance } : undefined,
    performance,
    positions,
  };
}

/** Trades newest first, as the history screen expects. */
export function sortTradesNewestFirst(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

/** Median hold time across closed trades — exported for the style module's tests/reuse. */
export function medianHoldMs(closed: { holdMs: number }[]): number | null {
  return median(closed.map((t) => t.holdMs));
}

/** Position filter used by the trades screen's BUY/SELL segmented control. */
export function filterTrades(trades: Trade[], side?: 'BUY' | 'SELL' | ''): Trade[] {
  return side ? trades.filter((t) => t.side === side) : trades;
}

/** A stored row priced for display without the full portfolio computation. */
export function priceStoredPosition(p: StoredPosition, prices: PriceResolver) {
  const point = prices(p.assetId);
  return toPosition(p, point?.priceUsd ?? null, point?.marketCapUsd ?? null, point?.symbol ?? null);
}
