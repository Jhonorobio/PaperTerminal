/**
 * Trading-style analytics — the "read on how you hold and size positions" screen, computed entirely
 * on-device from closed trades. Pure functions; all copy is English to match the rest of the UI.
 */

import type { TradingStyle } from '../types';
import type { EngineState } from './trades';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** `ClosedTrade.exitTime` is optional in the shared types; treat a missing stamp as epoch 0. */
const ms = (v?: string) => (v ? new Date(v).getTime() : 0);

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const avg = (ns: number[]) => (ns.length ? sum(ns) / ns.length : null);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function styleFor(medianHold: number | null, buyPct: number | null): { style: string; styleDescription: string } {
  const size = buyPct != null && buyPct >= 35 ? 'high-conviction ' : '';
  if (medianHold == null) {
    return { style: 'Trader', styleDescription: 'Close a few trades to get a read on your style.' };
  }
  if (medianHold < 30 * 60_000) {
    return {
      style: `${size}Scalper`.trim(),
      styleDescription: 'You close most positions within minutes and let quick moves compound.',
    };
  }
  if (medianHold < 6 * HOUR) {
    return {
      style: `${size}Day trader`.trim(),
      styleDescription: 'You work intraday moves and rarely carry a position overnight.',
    };
  }
  if (medianHold < 3 * DAY) {
    return {
      style: `${size}Swing trader`.trim(),
      styleDescription: 'You ride multi-hour to multi-day swings and tolerate heat along the way.',
    };
  }
  if (medianHold < 14 * DAY) {
    return {
      style: `${size}Position trader`.trim(),
      styleDescription: 'You let winners run across days and check the tape less often.',
    };
  }
  return {
    style: `${size}Diamond hands`.trim(),
    styleDescription: 'You hold for weeks — patience is your edge, as long as the thesis survives.',
  };
}

function longestWinningRun(pnls: number[]): number {
  let best = 0;
  let run = 0;
  for (const p of pnls) {
    if (p > 0) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best;
}

/** Deepest peak-to-trough drop of the realized-only equity curve, as a positive percentage. */
function maxDrawdownPct(startingBalance: number, pnls: number[]): number | null {
  if (!pnls.length || startingBalance <= 0) return null;
  let equity = startingBalance;
  let peak = startingBalance;
  let worst = 0;
  for (const p of pnls) {
    equity += p;
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    worst = Math.max(worst, dd);
  }
  return round1(worst);
}

/**
 * Builds the style card. With an empty sample it returns `{ sampleSize: 0 }` plus a zeroed hour
 * histogram, so the screen can render its progress ring instead of nulls.
 */
export function computeTradingStyle(state: EngineState): TradingStyle {
  const closed = [...state.closed].sort((a, b) => ms(a.exitTime) - ms(b.exitTime));
  const trades = [...state.trades].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const activityByHourUtc = new Array(24).fill(0);
  for (const t of trades) {
    const h = new Date(t.timestamp).getUTCHours();
    activityByHourUtc[h] += 1;
  }

  const base: TradingStyle = { sampleSize: closed.length, activityByHourUtc };
  if (!closed.length) return base;

  const pnls = closed.map((t) => t.realizedPnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses.filter((p) => p < 0)));

  const holds = closed.map((t) => t.holdMs ?? 0).sort((a, b) => a - b);
  const mid = Math.floor(holds.length / 2);
  const medianHold = holds.length % 2 ? holds[mid] : (holds[mid - 1] + holds[mid]) / 2;

  // "Percent of cash per buy": the buy row's cashAfter is post-fill cash, so the pre-fill cash is
  // cashAfter + notional + fee. Average across every buy the user ever made.
  const buyPercents = trades
    .filter((t) => t.side === 'BUY' && t.cashAfter != null && t.requestedValue)
    .map((t) => {
      const cashBefore = (t.cashAfter as number) + t.requestedValue! + (t.fee ?? 0);
      return cashBefore > 0 ? (t.requestedValue! / cashBefore) * 100 : 0;
    });
  const averageBuyPctOfCash = avg(buyPercents);

  const winRatePct = (wins.length / closed.length) * 100;
  const expectancyUsd = sum(pnls) / closed.length;
  const profitFactor = grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? null : 0;
  const bestReturnPct = Math.max(...closed.map((t) => t.returnPct));

  const { style, styleDescription } = styleFor(medianHold, averageBuyPctOfCash);
  const maxRealizedDrawdownPct = maxDrawdownPct(state.account?.startingBalance ?? 0, pnls);

  const insights: string[] = [];
  if (winRatePct < 45) insights.push('Your win rate is under 45% — most fills lose money. Tighten entries.');
  if (profitFactor != null && profitFactor < 1) insights.push('Gross losses outweigh gross wins. Consider sizing down or cutting losers sooner.');
  if (averageBuyPctOfCash != null && averageBuyPctOfCash >= 35) {
    insights.push('You routinely risk 35%+ of cash on a single buy — one bad fill swings the whole account.');
  }
  if (medianHold < 5 * 60_000 && expectancyUsd < 0) {
    insights.push('Sub-five-minute holds with negative expectancy: fees and slippage are eating the edge.');
  }
  if (maxRealizedDrawdownPct != null && maxRealizedDrawdownPct >= 30) {
    insights.push(`Closed-trade drawdown reached ${round1(maxRealizedDrawdownPct)}% — a stop-loss rule would cap the bleeding.`);
  }
  if (winRatePct >= 55 && expectancyUsd > 0) {
    insights.push('More winners than losers and a positive average trade — this is working. Keep the size consistent.');
  }

  return {
    ...base,
    style,
    styleDescription,
    medianHoldMs: Math.round(medianHold),
    winRatePct: round1(winRatePct),
    profitFactor,
    expectancyUsd: round2(expectancyUsd),
    averageWinUsd: avg(wins) != null ? round2(avg(wins) as number) : null,
    averageLossUsd: losses.length ? round2(avg(losses) as number) : null,
    averageBuySizeUsd: avg(trades.filter((t) => t.side === 'BUY').map((t) => t.requestedValue ?? 0)) as number | null,
    averageBuyPctOfCash: averageBuyPctOfCash != null ? round1(averageBuyPctOfCash) : null,
    maxRealizedDrawdownPct,
    longestWinningRun: longestWinningRun(pnls),
    personalBests: { bestReturnPct: round1(bestReturnPct) },
    insights,
  };
}
