/**
 * Token tracker — a SECOND Photon Graduated poller that snapshots the tokens you
 * care about, once a minute, so a migration can be analysed after the fact.
 *
 * Lifecycle:
 *   enter   — a token shows up in the Graduated column AND passes the track's OWN
 *             filter set (track_config; independent from the app column filters).
 *   capture — while it stays visible in the column: one snapshot per minute with
 *             top holders %, holders, fresh %, fresh holders, snipers %, snipers,
 *             bundle %, bundle count, buys, sells, market cap, volume and tp
 *             holders ("bots").
 *   pause   — it dropped out of the column: capture stops, the data stays; if it
 *             reappears capture resumes, over and over.
 *   cut     — 50 snapshots reached: the track is over for that token (its data is
 *             kept forever, it is never sampled again).
 *
 * The set is capped at 500 tokens: a new arrival evicts the oldest by
 * first-tracked time, so history stays bounded while always covering the newest
 * migrations.
 *
 * Hard gate: the poller idles until the track's OWN proxy (configured in the
 * app, never the shared FOMO/Photon one) is saved, and the track's filter set
 * has at least one field — no proxy, no entries; no filters, no entries.
 *
 * Own CycleTLS client + own backoff, so the app feed's rate limit and transport
 * never interact with tracking. Egress ONLY rides the track's own proxy — a dead
 * proxy means failed ticks and retries, never a direct fallback.
 */
import initCycleTLS from 'cycletls';

import { COMMON_FILTERS, HEADERS, SEARCH_URL, sanitizeColumnFilters } from './photon.js';
import { normalizeProxy } from './proxy-config.js';
import { trackConfig, trackTokens } from './stores.js';

// The column is pulled as fast as Photon sustains (same cadence as the FOMO
// watcher) so a token is caught the second it appears; the per-token snapshot
// stays at one per minute — that cadence is the product requirement.
const PULL_MS = 1300;
const SNAPSHOT_MS = 60_000;
// A miss must repeat before a token is paused: at 1.3s pulls a single
// partial/reshuffled column response would otherwise flip the whole list.
const TRACK_MISS_GRACE = 2;
// Terminal, not a pause forever: 30 continuous minutes out of the column end the
// run ("Cortado") even if the token never reached the 50-snapshot cap. Reappearing
// after the cut stays cut — same rule as hitting the cap.
const TRACK_PAUSE_CUT_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const PROXY_TEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_BACKOFF_MS = 45_000;
// Fails are usually a dead proxy answering in <1s — don't hammer it 46x/min.
const ERROR_BACKOFF_MS = 15_000;
export const TRACK_SNAPSHOT_MAX = 50;
export const TRACK_TOKENS_MAX = 500;

// Same field vocabulary the app's filter UI speaks (age in minutes, mktCap in
// thousands of USD — the convention the Photon columns already use).
const TRACK_FIELDS = ['age', 'holders', 'tpHolders', 'mktCap', 'buys', 'freshPct', 'bundleHolders', 'bundlePct'];

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── config (its own proxy + filters, both independent from the app columns) ──

export function getTrackConfig() {
  const stored = trackConfig.get('global') ?? {};
  // The tracker's OWN proxy — never the FOMO/Photon one; junk in the store reads as ''.
  let proxy = '';
  try {
    proxy = stored.proxy ? normalizeProxy(stored.proxy) : envProxy();
  } catch {
    proxy = '';
  }
  const storedFilters = sanitizeColumnFilters(stored.filters);
  return {
    enabled: stored.enabled !== false, // default on: it works out of the box
    proxy,
    // A wiped store (Railway restarts have no disk) falls back to the env floor, so a
    // redeploy can't silently lose the setup the user saved from the app.
    filters: Object.keys(storedFilters).length ? storedFilters : envFilters(),
  };
}

/** TRACK_PROXY env — restart-safe floor for the track's own proxy. */
function envProxy() {
  try {
    return process.env.TRACK_PROXY ? normalizeProxy(process.env.TRACK_PROXY) : '';
  } catch {
    return '';
  }
}

/** TRACK_FILTERS='{"holders":{"min":"60"}}' — same shape as the store, sanitized. */
function envFilters() {
  try {
    return sanitizeColumnFilters(JSON.parse(process.env.TRACK_FILTERS ?? '{}'));
  } catch {
    return {};
  }
}

/** Omitted fields keep their stored value — a partial PUT never wipes the rest. */
export function setTrackConfig(raw) {
  const stored = trackConfig.get('global') ?? {};
  let proxy = stored.proxy ?? '';
  if (raw?.proxy !== undefined) {
    try {
      proxy = normalizeProxy(raw.proxy); // '' allowed → cleared
    } catch (err) {
      throw Object.assign(new Error(err.message), { status: 400 }); // the app flashes this
    }
  }
  trackConfig.set('global', {
    enabled: raw?.enabled != null ? Boolean(raw.enabled) : stored.enabled !== false,
    proxy,
    filters: sanitizeColumnFilters(raw?.filters ?? stored.filters),
    updated_at: new Date().toISOString(),
  });
  return getTrackConfig();
}

/** The token's own attribute values, in the filter field vocabulary. */
function attrValues(a) {
  const created = numOrNull(a.created_timestamp); // epoch seconds
  return {
    age: created ? (Date.now() / 1000 - created) / 60 : null,
    holders: numOrNull(a.holders_count),
    tpHolders: numOrNull(a.tp_holders_count),
    mktCap: numOrNull(a.fdv),
    buys: numOrNull(a.buys_count),
    freshPct: numOrNull(a.fresh_holding_perc),
    bundleHolders: numOrNull(a.bundle_holders_count),
    bundlePct: numOrNull(a.bundle_holding_perc),
  };
}

/** A configured bound with no data to check against = the token does not pass. */
function passesFilters(values, filters) {
  for (const field of TRACK_FIELDS) {
    const pair = filters[field];
    if (!pair) continue;
    const v = values[field];
    if (v == null) return false;
    const mult = field === 'mktCap' ? 1000 : 1; // app types MC in thousands
    if (pair.min != null && v < Number(pair.min) * mult) return false;
    if (pair.max != null && v > Number(pair.max) * mult) return false;
  }
  return true;
}

/** One minute's worth of the stats the analysis runs on. */
function snapshotOf(a) {
  return {
    at: new Date().toISOString(),
    mcap: numOrNull(a.fdv),
    volume: numOrNull(a.volume),
    buys: numOrNull(a.buys_count),
    sells: numOrNull(a.sells_count),
    holders: numOrNull(a.holders_count),
    topHoldersPct: numOrNull(a.audit?.top_holders_perc),
    freshPct: numOrNull(a.fresh_holding_perc),
    freshHolders: numOrNull(a.fresh_holders_count),
    snipersPct: numOrNull(a.snipers_holding_perc),
    snipers: numOrNull(a.snipers_count),
    bundlePct: numOrNull(a.bundle_holding_perc),
    bundleHolders: numOrNull(a.bundle_holders_count),
    tpHolders: numOrNull(a.tp_holders_count),
  };
}

/**
 * Hard gate: the tracker idles until its OWN proxy is saved (never the
 * FOMO/Photon one — the track doesn't egress without its own) and the filter
 * set has at least one field. No proxy, no entries; no filters, no entries.
 */
export function getTrackGate() {
  const config = getTrackConfig();
  let proxyOk = false;
  let proxyUrl = '';
  try {
    proxyUrl = config.proxy ? normalizeProxy(config.proxy) : '';
    proxyOk = Boolean(proxyUrl);
  } catch {
    proxyOk = false;
  }
  const filtersOk = Object.keys(config.filters).length > 0;
  return {
    ok: proxyOk && filtersOk,
    proxy: { ok: proxyOk, url: proxyUrl },
    filters: { ok: filtersOk, count: Object.keys(config.filters).length },
  };
}

// ── transport (own client, own backoff) ──────────────────────────────────────

let cycleTLS = null;
let transport = 'direct';
let poller = null;
let trackInflight = null;
const missCount = new Map(); // address → consecutive pulls absent (pause grace, in-memory)
let backoffUntil = 0;
let fetchCount = 0;
let errorCount = 0;
let lastError = null;
let lastFetchAt = 0;
let gateLogged = false;

async function getCycleTLS() {
  if (!cycleTLS) cycleTLS = await initCycleTLS();
  return cycleTLS;
}

export async function closeTrack() {
  if (poller) clearInterval(poller);
  poller = null;
  if (cycleTLS) {
    const c = cycleTLS;
    cycleTLS = null;
    try {
      await c.exit();
    } catch {}
  }
}

/** Fetches the RAW Graduated column (no query filters — matching is local). */
async function fetchGraduated() {
  fetchCount += 1;
  const client = await getCycleTLS();
  // The gate guarantees the track's own proxy is here; it is the ONLY egress —
  // no silent fallback to direct (that IP is exactly what the user is avoiding).
  const proxyUrl = getTrackConfig().proxy;
  transport = proxyUrl ? 'proxy' : 'direct';
  const request = client(
    `${SEARCH_URL}?${COMMON_FILTERS}&col=col3`,
    { client: 'chrome131', headers: HEADERS, ...(proxyUrl ? { proxy: proxyUrl } : {}) },
    'GET',
  );
  let timer;
  let resp;
  try {
    resp = await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT_${FETCH_TIMEOUT_MS}MS`)), FETCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    request.catch(() => {});
  }

  const status = Number(resp?.status) || 0;
  if (status === 429) {
    backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    throw Object.assign(new Error('RATE_LIMITED'), { rateLimited: true });
  }
  if (status !== 200) {
    // CycleTLS reports an unreachable/broken proxy as a bare 401 — say it plainly.
    throw new Error(proxyUrl && status === 401 ? 'PROXY_401 (el proxy no respondió o rechazó)' : `HTTP_${status}`);
  }

  return toItems(resp);
}

/** CycleTLS hands the body over parsed (object) or as raw bytes — accept both. */
function toItems(resp) {
  const raw = resp?.data;
  let json;
  if (raw != null && typeof raw === 'object' && !Buffer.isBuffer(raw)) {
    json = raw;
  } else {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('BAD_BODY');
    }
  }
  if (json.error) throw new Error(String(json.error));
  const slice = json.columns?.col3 ?? { data: [] };
  const items = Array.isArray(slice.data) ? slice.data : [];
  return items.map((it) => it?.attributes).filter(Boolean);
}

// ── proxy test (the app's "Probar" button) ───────────────────────────────────

/**
 * One real Graduated fetch through a proxy, timed — the app's way of knowing
 * whether the proxy works BEFORE trusting it with tracking. Accepts an unsaved
 * draft (testing doesn't require saving first) and never throws: every outcome
 * comes back shaped, so the UI can just print it.
 */
export async function testTrackProxy(rawProxy) {
  let proxyUrl = '';
  try {
    proxyUrl = normalizeProxy(rawProxy ?? getTrackConfig().proxy);
  } catch (err) {
    return { ok: false, stage: 'config', ms: 0, error: String(err?.message || err) };
  }
  if (!proxyUrl) return { ok: false, stage: 'config', ms: 0, error: 'no hay proxy cargado' };

  const started = Date.now();
  const request = (await getCycleTLS())(
    `${SEARCH_URL}?${COMMON_FILTERS}&col=col3`,
    { client: 'chrome131', headers: HEADERS, proxy: proxyUrl },
    'GET',
  );
  let timer;
  let resp;
  try {
    resp = await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT_${PROXY_TEST_TIMEOUT_MS}MS`)), PROXY_TEST_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    return { ok: false, proxy: proxyUrl, ms: Date.now() - started, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
    request.catch(() => {});
  }

  const ms = Date.now() - started;
  const status = Number(resp?.status) || 0;
  if (status !== 200) {
    return {
      ok: false,
      proxy: proxyUrl,
      status,
      ms,
      error: status === 401 ? 'el proxy no respondió o rechazó (¿es SOCKS? usá socks5://)' : `HTTP_${status}`,
    };
  }
  try {
    return { ok: true, proxy: proxyUrl, status, ms, tokens: toItems(resp).length };
  } catch (err) {
    return { ok: false, proxy: proxyUrl, status, ms, error: String(err?.message || err) };
  }
}

// ── the tick ─────────────────────────────────────────────────────────────────

function evictOverCap() {
  while (Object.keys(trackTokens.getAll()).length > TRACK_TOKENS_MAX) {
    let oldest = null;
    for (const t of Object.values(trackTokens.getAll())) {
      if (!oldest || String(t.firstSeenAt) < String(oldest.firstSeenAt)) oldest = t;
    }
    if (!oldest) break;
    trackTokens.delete(oldest.address);
  }
}

async function trackTick() {
  try {
    if (Date.now() < backoffUntil) return;
    const config = getTrackConfig();
    if (!config.enabled) return;

    // Proxy + at least one filter, or there is nothing to do (the app's Track tab
    // says exactly what's missing).
    const gate = getTrackGate();
    if (!gate.ok) {
      if (!gateLogged) {
        gateLogged = true;
        const missing = [!gate.proxy.ok ? 'proxy' : null, !gate.filters.ok ? 'filtro' : null].filter(Boolean).join(' + ');
        console.log(`[track] en espera — falta configurar: ${missing}`);
      }
      return;
    }
    gateLogged = false;

    const attrs = await fetchGraduated();
    lastFetchAt = Date.now();
    lastError = null;

    const nowIso = new Date().toISOString();
    const byAddress = new Map();
    for (const a of attrs) {
      const address = a.tokenAddress || a.address;
      if (address) byAddress.set(address, a);
    }

    let changed = false; // anything worth persisting + logging happened

    for (const [address, a] of byAddress) {
      let tracked = trackTokens.get(address);
      // Persist only on structural changes (enter / resume / identity / snapshot):
      // at 1.3s cadence, lastSeenAt mutates memory every pull but rewriting the
      // whole store (up to 500 tokens × 50 snaps) 46x/min would be absurd.
      let persist = false;
      if (!tracked) {
        // New to the column: only enters the set if it passes the track filters.
        if (!passesFilters(attrValues(a), config.filters)) continue;
        tracked = {
          address,
          chain: 'sol',
          symbol: a.symbol ?? null,
          name: a.name ?? null,
          logo: a.imgUrl ?? null,
          status: 'active',
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          visible: true,
          snapshots: [],
        };
        persist = true;
      } else {
        if (!tracked.visible) {
          tracked.visible = true; // resumed after a pause
          persist = true;
        }
        tracked.lastSeenAt = nowIso;
        // The first sighting can miss the logo or the symbol.
        if (!tracked.symbol && a.symbol) { tracked.symbol = a.symbol; persist = true; }
        if (!tracked.name && a.name) { tracked.name = a.name; persist = true; }
        if (!tracked.logo && a.imgUrl) { tracked.logo = a.imgUrl; persist = true; }
      }

      // One snapshot per minute, only while the track is still open (dense pulls
      // make the old tick-relative slack unnecessary — due lands within 1.3s).
      if (tracked.status === 'active' && tracked.snapshots.length < TRACK_SNAPSHOT_MAX) {
        const lastAt = tracked.snapshots[tracked.snapshots.length - 1]?.at;
        if (!lastAt || Date.now() - Date.parse(lastAt) >= SNAPSHOT_MS) {
          tracked.snapshots.push(snapshotOf(a));
          persist = true;
          if (tracked.snapshots.length >= TRACK_SNAPSHOT_MAX) tracked.status = 'done'; // 50 → se corta
        }
      }

      if (persist) {
        trackTokens.set(address, tracked);
        changed = true;
      }
    }

    // Tracked tokens missing from this column: paused after a couple of misses —
    // at 1.3s pulls a single partial/reshuffled response must not flip the list.
    // Data is kept; capture resumes on the next appearance. A token that stays
    // out for 30 continuous minutes is done for good (its run ended), even if it
    // never hit the snapshot cap — "paused forever" was never a real state.
    for (const [address, tracked] of Object.entries(trackTokens.getAll())) {
      if (byAddress.has(address)) {
        missCount.delete(address);
        continue;
      }
      if (!tracked.visible) {
        // Already paused: check the 30-min cut against the last time it was seen.
        if (tracked.status === 'active' && Date.now() - Date.parse(tracked.lastSeenAt) >= TRACK_PAUSE_CUT_MS) {
          tracked.status = 'done';
          trackTokens.set(address, tracked);
          changed = true;
        }
        continue;
      }
      const misses = (missCount.get(address) ?? 0) + 1;
      missCount.set(address, misses);
      if (misses < TRACK_MISS_GRACE) continue;
      tracked.visible = false;
      missCount.delete(address);
      trackTokens.set(address, tracked);
      changed = true;
    }

    evictOverCap();
    if (changed) console.log(`[track] tick · ${byAddress.size} in column · ${Object.keys(trackTokens.getAll()).length} tracked`);
  } catch (err) {
    errorCount += 1;
    lastError = { message: String(err?.message || err), at: Date.now() };
    // A dead proxy fails fast — back off so 1.3s ticks don't hammer it (or the
    // log). The 429 path already set its longer rate-limit backoff.
    if (!err?.rateLimited) backoffUntil = Date.now() + ERROR_BACKOFF_MS;
    console.error('[track] tick failed:', lastError.message);
  }
}

// One pull at a time: a slow proxy holds a tick for seconds, and the interval
// must not stack requests on top of it (same single-flight rule as photon.js).
function pollTick() {
  try {
    if (Date.now() < backoffUntil) return;
    if (trackInflight) return;
    trackInflight = trackTick().finally(() => {
      trackInflight = null;
    });
  } catch {
    /* the timer must never crash */
  }
}

export function startTrackPoller() {
  if (poller) return;
  // A short delay so booting doesn't race Photon's own warm-up with a second
  // cold CycleTLS init.
  setTimeout(() => void trackTick(), 5_000);
  poller = setInterval(pollTick, PULL_MS);
  console.log(
    `[track] poller started (col3 every ${PULL_MS}ms, 1 snap/${SNAPSHOT_MS / 1000}s per token, ≤${TRACK_SNAPSHOT_MAX} snaps/token, ≤${TRACK_TOKENS_MAX} tokens)`
  );
}

// ── reads (the HTTP surface) ─────────────────────────────────────────────────

export function getTrackStatus() {
  const all = Object.values(trackTokens.getAll());
  return {
    running: Boolean(poller),
    enabled: getTrackConfig().enabled,
    gate: getTrackGate(),
    // Two independent cadences: pulls detect presence/identity every PULL_MS;
    // snapshots (the stats series) stay at one per SNAPSHOT_MS per token.
    pullMs: PULL_MS,
    snapshotMs: SNAPSHOT_MS,
    // 30 continuous minutes out of the column end the run ("Cortado").
    pauseCutMs: TRACK_PAUSE_CUT_MS,
    snapshotMax: TRACK_SNAPSHOT_MAX,
    tokensMax: TRACK_TOKENS_MAX,
    lastFetchAt: lastFetchAt || null,
    fetchCount,
    errorCount,
    // Survives until the next successful tick clears it — a dead proxy has to
    // stay visible (a 10s freshness window against 60s ticks hid it forever).
    lastError,
    transport,
    proxy: { url: getTrackConfig().proxy },
    counts: {
      total: all.length,
      active: all.filter((t) => t.status === 'active').length,
      done: all.filter((t) => t.status === 'done').length,
      visible: all.filter((t) => t.visible).length,
    },
  };
}

/**
 * Health pill for one token — derived from its OWN snapshot series (nothing
 * extra to persist). Signals, in order of measured strength on ~130 tracked
 * tokens: holders growth (r=0.82 vs final return), net buying, drawdown,
 * turnover (vol/mcap — ≥10x means distribution: 0% of those doubled, median
 * −67%) and bundle collapse (insiders dumping, −22pts on the dead vs +1 on
 * the winners). Also: 3 consecutive up minutes early = 83% chance of doubling.
 *   green  holders ≥ +10% first→last AND buys ≥ sells AND above entry, with
 *          turnover < 8x and no bundle dump — or 3+ up minutes with buying
 *   red    holders ≤ −10%, or shrinking under selling pressure, or down ≥ −50%
 *          from the tracked peak, or turnover ≥ 10x, or bundle collapsing ≤ −10
 *   amber  mixed signals — null until there are 2 snapshots to judge
 */
export function trackHealth(snaps) {
  if (!Array.isArray(snaps) || snaps.length < 2) return { health: null, holdersDeltaPct: null, flowRatio: null, turnover: null };
  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  const holdersDeltaPct =
    first.holders != null && last.holders != null && first.holders > 0
      ? ((last.holders - first.holders) / first.holders) * 100
      : null;
  // buys/sells are cumulative: a window's flow is the delta across it (~3 min
  // when the series is long enough, so one noisy minute can't flip the chip).
  const prev = snaps[Math.max(0, snaps.length - 4)];
  let flowRatio = null;
  if (last.buys != null && last.sells != null && prev.buys != null && prev.sells != null) {
    const dBuys = last.buys - prev.buys;
    const dSells = last.sells - prev.sells;
    if (dSells > 0) flowRatio = dBuys / dSells;
    else if (dBuys > 0) flowRatio = 99; // window with no sellers at all
    else if (last.sells > 0) flowRatio = last.buys / last.sells; // flat window → lifetime ratio
  }
  // Drawdown from the tracked peak — a run that gave back half is broken even
  // if holders still look fine on paper.
  let peak = null;
  for (const s of snaps) if (s.mcap != null && (peak == null || s.mcap > peak)) peak = s.mcap;
  const drawdownPct = peak != null && last.mcap != null ? (last.mcap / peak - 1) * 100 : null;
  // Return vs the FIRST tracked mcap — green must not sit below its entry.
  const entryReturnPct = first.mcap != null && last.mcap != null && first.mcap > 0 ? (last.mcap / first.mcap - 1) * 100 : null;
  // Turnover NOW (volume ÷ mcap): healthy = a few x; ≥10x = they are exiting
  // into the volume (0% of tracked tokens with ≥10x ended above entry).
  const turnover = last.mcap > 0 ? numOrNull(last.volume) != null ? last.volume / last.mcap : null : null;
  // Bundle delta over the window: insiders dumping shows here first (the dead
  // lost ~22 pts of bundled supply while the winners stayed flat).
  const bundleDeltaPct =
    numOrNull(last.bundlePct) != null && numOrNull(prev.bundlePct) != null ? last.bundlePct - prev.bundlePct : null;
  // Momentum: consecutive latest snapshots each above the previous. 3+ up
  // minutes early was the single strongest pattern (83% doubled, n=12).
  let upStreak = 0;
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i].mcap != null && snaps[i - 1].mcap != null && snaps[i].mcap > snaps[i - 1].mcap) upStreak++;
    else break;
  }

  let health = 'amber';
  if (
    (holdersDeltaPct != null && holdersDeltaPct <= -10) ||
    (holdersDeltaPct != null && holdersDeltaPct < 0 && (flowRatio == null || flowRatio < 1)) ||
    (drawdownPct != null && drawdownPct <= -50) ||
    (turnover != null && turnover >= 10) ||
    (bundleDeltaPct != null && bundleDeltaPct <= -10)
  ) {
    health = 'red';
  } else if (
    (holdersDeltaPct != null &&
      holdersDeltaPct >= 10 &&
      flowRatio != null &&
      flowRatio >= 1 &&
      (entryReturnPct == null || entryReturnPct >= -10)) ||
    (upStreak >= 3 && flowRatio != null && flowRatio >= 1)
  ) {
    // The holders+-but-dying trap: high turnover or an insider dump downgrades
    // green to amber even when the other signals look fine.
    health = (turnover != null && turnover >= 8) || (bundleDeltaPct != null && bundleDeltaPct <= -5) ? 'amber' : 'green';
  }
  return { health, holdersDeltaPct, flowRatio, turnover };
}

/**
 * Snapshots with the chip as it looked AT THAT MINUTE — each computed from the
 * prefix [0..i] only, so the timeline shows the live signal, never hindsight.
 * The first snapshot carries no chip (nothing to compare against yet).
 */
export function snapshotsWithHealth(snaps) {
  const series = Array.isArray(snaps) ? snaps : [];
  return series.map((s, i) => {
    const h = trackHealth(series.slice(0, i + 1));
    return { ...s, health: h.health, turnover: h.turnover };
  });
}

/** Summary fields for one tracked token (the list row + the detail's header). */
export function summarizeTrackToken(t) {
  const snaps = Array.isArray(t.snapshots) ? t.snapshots : [];
  const last = snaps[snaps.length - 1];
  const firstMcap = snaps[0]?.mcap ?? null;
  let maxMcap = null;
  for (const s of snaps) if (s.mcap != null && (maxMcap == null || s.mcap > maxMcap)) maxMcap = s.mcap;
  return {
    address: t.address,
    chain: t.chain ?? 'sol',
    symbol: t.symbol ?? null,
    name: t.name ?? null,
    logo: t.logo ?? null,
    status: t.status,
    firstSeenAt: t.firstSeenAt,
    lastSeenAt: t.lastSeenAt,
    visible: Boolean(t.visible),
    snapshotCount: snaps.length,
    // the row's "MC / VOL" line comes from the newest snapshot
    mcap: last?.mcap ?? null,
    volume: last?.volume ?? null,
    // first snapshot → the highest seen: how far it pumped while tracked
    maxMcap,
    gainPct: firstMcap && maxMcap != null ? (maxMcap / firstMcap - 1) * 100 : null,
    // the health chip: green / amber / red (null < 2 snapshots)
    ...trackHealth(snaps),
  };
}

/** Summaries without snapshots (the list); newest activity first. */
export function listTrackTokens() {
  return Object.values(trackTokens.getAll())
    .map(summarizeTrackToken)
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
}

/** One tracked token with its full snapshot series (the detail view / analysis). */
export function getTrackToken(address) {
  const t = trackTokens.get(String(address ?? '').toLowerCase()) ?? trackTokens.get(String(address ?? ''));
  return t ?? null;
}

export function clearTrack() {
  for (const key of Object.keys(trackTokens.getAll())) trackTokens.delete(key);
  return { cleared: true };
}
