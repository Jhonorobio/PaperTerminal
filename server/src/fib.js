/**
 * Track Fibonacci watcher.
 *
 * Scope: ONLY the tokens currently visible in the Track "Graduated" section
 * (`trackTokens` entries with `visible === true`). The time series comes from
 * Azura's `v2.tokens.getBars` (30S candles, no proxy/auth needed). Cielo's
 * websocket exposes heartbeats for its OHLCV channel group, not candle data.
 *
 * Anchors are fixed when the token starts being watched:
 *   base = lowest low since launch (the whole series returned by getBars)
 *   ATH  = highest high known at that moment
 * Levels are the six the chart draws: 0.236, 0.382, 0.5, 0.618, 0.786, 1.0.
 * They are NOT re-anchored after a move: using a future ATH would repaint the
 * levels and make the alert look clairvoyant.
 *
 * "Alert on every level" means one alert per level per token: a bar that
 * crosses/touches a level marks it seen. A full history fetch on first sight
 * only seeds the state (lastBarTime + lastClose), so it never backfills alerts
 * for levels the token already touched before we started watching.
 */

import { trackConfig, trackFib, trackTokens } from './stores.js';
import { emitTrackFib } from './notify.js';

const AZURA_BARS_URL = 'https://gateway.azura.xyz/trpc/v2.tokens.getBars';
const CHAIN_ID = 1399811149;
const RESOLUTION = '30S';
const COUNT_BACK = 2_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_PAGES = 10;
const DEFAULT_SUPPLY = 1_000_000_000;

/** The six levels drawn on the Track chart (low -> high convention). */
export const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786, 1];

const POLL_MS = 60_000;
const BOOT_DELAY_MS = 15_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const FULL_REFRESH_GAP_MS = 6 * 60 * 60_000;
// A restart/deploy can leave lastBarTime minutes behind. Alerts from bars older
// than this are history, not news; skip them instead of backfilling the chat.
const MAX_CATCHUP_MS = 10 * 60_000;

const num = (value) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Levels for a fixed base/ATH pair. */
export function fibLevels(base, ath) {
  const b = num(base);
  const a = num(ath);
  if (b == null || a == null || b <= 0 || a <= b) return [];
  return FIB_RATIOS.map((ratio) => ({ ratio, price: b + (a - b) * ratio }));
}

/**
 * True when a candle touches/crosses `level`. The previous close is included so
 * a gap through a level still counts even if the bar's own range does not
 * contain it.
 */
export function levelTouched(prevClose, bar, level) {
  const prices = [prevClose, bar?.open, bar?.high, bar?.low, bar?.close].filter((v) => Number.isFinite(v));
  if (!prices.length) return false;
  return Math.min(...prices) <= level && level <= Math.max(...prices);
}

function normalizeBar(row) {
  let time = num(row?.time);
  if (time == null) return null;
  if (time < 1e12) time *= 1000; // ms everywhere else in the app
  const open = num(row?.open);
  const high = num(row?.high);
  const low = num(row?.low);
  const close = num(row?.close);
  const volume = num(row?.volume);
  if (!Number.isFinite(time) || high == null || low == null || close == null) return null;
  return { time, open, high, low, close, volume };
}

function mergeBars(...lists) {
  const byTime = new Map();
  for (const list of lists) {
    for (const bar of list) byTime.set(bar.time, bar);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function fetchPage(address, { from, to, countBack = COUNT_BACK }) {
  const input = encodeURIComponent(
    JSON.stringify({
      json: {
        chainId: CHAIN_ID,
        tokenAddress: address,
        resolution: RESOLUTION,
        from: Math.max(0, Math.floor(from)),
        to: Math.max(1, Math.floor(to)),
        countBack,
      },
    }),
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${AZURA_BARS_URL}?input=${input}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`AZURA_${res.status}`), {
        status: res.status,
        body: body.slice(0, 300),
      });
    }
    const payload = await res.json();
    const data = payload?.result?.data?.json;
    const bars = (Array.isArray(data?.price) ? data.price : [])
      .map(normalizeBar)
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);
    const supply = num(data?.marketCapSupply);
    return {
      bars,
      supply: supply != null && supply > 0 ? supply : null,
      hasMoreHistory: Boolean(data?.hasMoreHistory),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Full launch history, paging backwards until the endpoint says there is no more. */
async function fetchFullHistory(address, nowMs = Date.now()) {
  let to = Math.ceil(nowMs / 1000);
  let bars = [];
  let supply = null;
  let previousOldest = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(address, { from: 0, to, countBack: COUNT_BACK });
    supply = result.supply ?? supply;
    bars = mergeBars(bars, result.bars);

    const first = result.bars[0];
    if (!first || !result.hasMoreHistory) break;
    if (previousOldest != null && first.time >= previousOldest) break;
    previousOldest = first.time;

    const nextTo = Math.floor(first.time / 1000) - 1;
    if (nextTo <= 0 || nextTo >= to) break;
    to = nextTo;
  }

  return { bars, supply: supply ?? DEFAULT_SUPPLY };
}

/** Recent bars since the last processed one (with a small overlap). */
async function fetchNewBars(address, state, nowMs = Date.now()) {
  const since = state.lastBarTime;
  // A long pause is cheaper to reconstruct from a full history than to page
  // backwards by hand; the token is short-lived anyway.
  if (nowMs - since > FULL_REFRESH_GAP_MS) {
    const full = await fetchFullHistory(address, nowMs);
    return { bars: full.bars.filter((bar) => bar.time > since), supply: full.supply };
  }
  const from = Math.max(0, Math.floor(since / 1000) - 60);
  const result = await fetchPage(address, {
    from,
    to: Math.ceil(nowMs / 1000),
    countBack: COUNT_BACK,
  });
  return { bars: result.bars.filter((bar) => bar.time > since), supply: result.supply };
}

function identityOf(token) {
  const snaps = Array.isArray(token?.snapshots) ? token.snapshots : [];
  const last = snaps[snaps.length - 1] ?? null;
  return {
    address: token?.address,
    symbol: token?.symbol ?? null,
    name: token?.name ?? null,
    logo: token?.logo ?? null,
    volume: last?.volume ?? null,
    holders: last?.holders ?? null,
  };
}

function newState(token, bars, supply) {
  const base = Math.min(...bars.map((bar) => bar.low));
  const ath = Math.max(...bars.map((bar) => bar.high));
  const levels = fibLevels(base, ath);
  const last = bars[bars.length - 1];
  if (!levels.length || !last) return null;
  const at = new Date().toISOString();
  return {
    ...identityOf(token),
    base,
    ath,
    supply: supply ?? DEFAULT_SUPPLY,
    levels,
    seen: {},
    lastBarTime: last.time,
    lastClose: last.close,
    startedAt: at,
    updatedAt: at,
  };
}

/**
 * Watches one token. Returns the number of alerts emitted.
 * First sight only seeds; later polls process new bars and fire each level once.
 */
async function pollToken(token) {
  const address = token.address;
  const now = Date.now();
  let state = trackFib.get(address);

  if (!state) {
    const full = await fetchFullHistory(address, now);
    if (full.bars.length < 2) return 0;
    state = newState(token, full.bars, full.supply);
    if (!state) return 0;
    trackFib.set(address, state);
    return 0;
  }

  const { bars, supply } = await fetchNewBars(address, state, now);
  if (supply != null) state.supply = supply;

  // Keep identity/volume fresh even on a quiet minute.
  const identity = identityOf(token);
  if (identity.symbol) state.symbol = identity.symbol;
  if (identity.name) state.name = identity.name;
  if (identity.logo) state.logo = identity.logo;

  if (!bars.length) {
    state.updatedAt = new Date().toISOString();
    trackFib.set(address, state);
    return 0;
  }

  const hits = [];
  const catchupFloor = now - MAX_CATCHUP_MS;
  for (const bar of bars) {
    // Only alert on recent bars. The state still advances through old ones so a
    // long downtime does not replay every level the token touched while we were out.
    if (bar.time >= catchupFloor) {
      for (const level of state.levels) {
        if (state.seen[level.ratio]) continue;
        if (!levelTouched(state.lastClose, bar, level.price)) continue;
        state.seen[level.ratio] = new Date().toISOString();
        hits.push({ level, bar });
      }
    }
    state.lastClose = bar.close;
    state.lastBarTime = Math.max(state.lastBarTime, bar.time);
  }

  state.updatedAt = new Date().toISOString();
  trackFib.set(address, state);

  let emitted = 0;
  for (const { level, bar } of hits) {
    const mcap = bar.close * state.supply;
    const alertToken = {
      address,
      symbol: state.symbol,
      name: state.name,
      logo: state.logo,
      mcap,
      volume: identity.volume,
      holders: identity.holders,
    };
    if (
      emitTrackFib(
        alertToken,
        { ratio: level.ratio, price: level.price },
        { base: state.base, ath: state.ath, supply: state.supply, current: bar.close },
      )
    ) {
      emitted += 1;
    }
  }
  return emitted;
}

let poller = null;
let bootTimer = null;
let inflight = null;
let lastPollAt = null;
let pollCount = 0;
let alertCount = 0;
let lastError = null;
let backoffUntil = 0;

/** Visible tokens in the Track Graduated section (nothing while Track is off). */
export function fibTargets() {
  const config = trackConfig.get('global') ?? {};
  if (config.enabled === false) return [];
  return Object.values(trackTokens.getAll()).filter((tracked) => tracked?.visible && tracked.address);
}

async function fibTick() {
  lastPollAt = Date.now();
  pollCount += 1;
  let emitted = 0;

  for (const token of fibTargets()) {
    if (Date.now() < backoffUntil) break;
    try {
      emitted += await pollToken(token);
      lastError = null;
    } catch (err) {
      lastError = {
        message: String(err?.message || err).slice(0, 300),
        status: err?.status ?? null,
        at: Date.now(),
      };
      console.error('[fib] poll failed:', lastError.message);
      if (err?.status === 429) {
        backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        break;
      }
    }
  }

  alertCount += emitted;
  if (emitted) console.log(`[fib] ${emitted} alert${emitted === 1 ? '' : 's'} emitted`);
}

function tick() {
  if (inflight) return inflight;
  inflight = fibTick()
    .catch((err) => {
      lastError = { message: String(err?.message || err).slice(0, 300), at: Date.now() };
      console.error('[fib] tick failed:', lastError.message);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function startFibWatcher() {
  if (poller) return;
  bootTimer = setTimeout(() => void tick(), BOOT_DELAY_MS);
  poller = setInterval(() => void tick(), POLL_MS);
  console.log(`[fib] watcher started (30S candles, every ${POLL_MS / 1000}s, visible Graduated only)`);
}

export function stopFibWatcher() {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
}

/** Diagnostics for /api/track/fib and the export. */
export function getFibStatus() {
  return {
    running: Boolean(poller),
    resolution: RESOLUTION,
    pollMs: POLL_MS,
    lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
    pollCount,
    alertCount,
    lastError,
    tokens: Object.values(trackFib.getAll()).map((state) => ({
      address: state.address,
      symbol: state.symbol,
      base: state.base,
      ath: state.ath,
      supply: state.supply,
      levels: state.levels,
      seen: Object.keys(state.seen ?? {}),
      lastBarTime: state.lastBarTime ? new Date(state.lastBarTime).toISOString() : null,
      startedAt: state.startedAt ?? null,
      updatedAt: state.updatedAt ?? null,
    })),
  };
}
