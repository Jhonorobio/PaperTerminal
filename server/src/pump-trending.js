/**
 * Pump Trending board — pump.fun's own "hot right now" list, polled from the
 * advanced-indexer endpoint the web app uses:
 *   https://advanced-indexer.pump.fun/boards/trending?…&chains=solana
 * The first 5 Solana entries become the app's "Pump Trend." tab, and a token
 * that ENTERS the board fires an alert once per address (seen-map, same recipe
 * as the FOMO feeds).
 *
 * Why plain HTTP polling and not the FOMO socket: this board is pump.fun's, not
 * FOMO's — a bare GET with a browser UA, no auth and no session params (200
 * direct, measured locally and from any egress IP), and the payload is tiny with
 * limit=5 (~5 KB/call). Measured churn of the top 5: 0 changes in ~8 minutes, so
 * a 60 s cadence catches every new entrant within a minute while staying under
 * ~7 MB/day of traffic. A failed poll keeps the last good board on screen.
 */

import { broadcast, registerTopicProvider } from './ws.js';
import { emitToken, seedSeen } from './notify.js';

const BOARD_URL =
  'https://advanced-indexer.pump.fun/boards/trending?limit=5&offset=0&ranking=social&window=1h&hot=label&chains=solana';
const POLL_MS = 60_000;
const TOP_N = 5;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let tokens = [];
let savedAt = 0;
/** The first board after boot seeds the seen-maps silently — nobody gets a
 * "5 tokens entraron" push just because the server (re)started. */
let firstDone = false;
let timer = null;

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Board entry (short keys: m/c/n/t/i/mc/p/vUsd24h/age/kol) → the app's FomoToken
 * shape, so the FOMO screen renders it with the very same row/list code. */
function normalize(e, rank, nowMs) {
  const age = num(e.age); // seconds since creation
  return {
    address: str(e.m),
    // Keep the board's own case ("dev/null" reads better than "DEV/NULL").
    symbol: str(e.t),
    name: str(e.n),
    image: str(e.i),
    launchpad: null,
    createdAt: age != null ? Math.floor(nowMs / 1000) - age : null,
    mcap: num(e.mc),
    price: num(e.p),
    vol24: num(e.vUsd24h),
    change24: null,
    holders: null,
    rank,
    kolCount: num(e.kol),
    updatedAt: nowMs,
  };
}

/** notify.js's push body reads these fields; the board doesn't expose liquidity. */
function alertOf(t, nowMs) {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    image: t.image,
    mcap: t.mcap,
    liquidity: null,
    volume: t.vol24,
    holders: null,
    kolCount: t.kolCount,
    ageMinutes: t.createdAt != null ? Math.floor(nowMs / 1000 - t.createdAt) : null,
  };
}

async function fetchBoard() {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(BOARD_URL, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // transient failure: keep the last good board
  } finally {
    clearTimeout(to);
  }
}

async function poll() {
  const json = await fetchBoard();
  const entries = Array.isArray(json?.entries) ? json.entries : null;
  if (!entries?.length) return;
  const nowMs = Date.now();
  const list = entries
    .filter((e) => str(e?.c)?.startsWith('solana'))
    .slice(0, TOP_N)
    .map((e, i) => normalize(e, i + 1, nowMs))
    .filter((t) => t.address);
  if (!list.length) return;

  tokens = list;
  savedAt = nowMs;
  // Full list, snapshot semantics — same contract as the FOMO feeds.
  broadcast('pump_trending', { event: 'pump_trending_updated', data: { tokens, savedAt, snapshot: true } });

  if (!firstDone) {
    firstDone = true;
    seedSeen('pump_trending', tokens.map((t) => t.address));
    return;
  }
  // From the next poll on: entering the board is what fires the alert.
  // emitToken dedups per address+category via the seen-store, so a token that
  // stays on the board (or comes back next week) never re-alerts.
  for (const t of tokens) emitToken('pump_trending', alertOf(t, nowMs));
}

export function startPumpTrending() {
  if (timer) return;
  // A freshly connected app gets the current board immediately instead of
  // waiting up to one full poll for the next broadcast.
  registerTopicProvider('pump_trending', () => ({
    event: 'pump_trending_updated',
    data: { tokens, savedAt, snapshot: true },
  }));
  timer = setInterval(() => void poll(), POLL_MS);
  void poll();
}

/** Current board (for REST/debug). */
export function getPumpTrending() {
  return { tokens, savedAt };
}
