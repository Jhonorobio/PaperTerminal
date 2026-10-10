/**
 * Photon memescope feed — ported and trimmed from
 * `server con APIS/src/services/photon-memescope.js`.
 *
 * Photon's API answers CycleTLS (a real Chrome TLS fingerprint) but challenges
 * plain fetch with Cloudflare's "Just a moment..." — which is why this runs on a
 * server and not on the phone. One request per column, rotating every 1.3s so
 * upstream traffic stays under the rate limit (429 → 45s backoff).
 *
 * Columns: col1 = New, col3 = Graduated. Each refresh is broadcast to the app's
 * WS topic `memescope`; newly-seen tokens run through notify.js for the per-column
 * alert categories photon_new / photon_graduated.
 */

import initCycleTLS from 'cycletls';

import { photonFilters } from './stores.js';
import { broadcast, registerTopicProvider } from './ws.js';
import { emitToken, seedSeen } from './notify.js';
import { getEffectiveProxy, getProxyStatus, onProxyChange } from './proxy-config.js';

const SEARCH_URL = 'https://photon-sol.tinyastro.io/api/memescope/search';
const DEFAULT_TA =
  '%2BGwOfWeQXAdpObsrbWbYS4vdSrTe5DyYZYGZyWWrgjc3wnJs1sBXV54nyBjf8moVolF87pu3FuBkpi6THzirx5zJ5ycXBFGwanMgB%2BnWxySZ3kQkUpBIHGLWcskMvI8%2FyhcTneZcavfpOHocyeASyqWR%2Fxjrj5Wdtg1gYi%2BUGZrW6LrUFO6CausIAiuUmll74MNPL4ke9q8dqdHwOXKacAz2Go8PHNkysFui8nf0lVsuOarFTSN2pAON103FitzKXH2Od6BhuOeFQtvbuHq8%2FN9QW9T12cH3pZ4LsKbIeARo0BqEpwiM7weVCieEPimC7fj3MwDfOQ%2Fl7Kl864A7ZArqBV3N%2FZuaF%2FCeFBJchYndc7XmcgXfwXEmHBEJ0572%2BIu%2FxLFYxxyPe4G2jSsy6lKj2ePgYSvpTm%2BycWirh2GglInPezLLtXephFUXOU%2FmiOLJ%2FtXC2K4%2FezjU0hCYicG1bwyJEKPdnkgjhcEByIkvO8%2BikldoLN4IqHnj7yfriRlntQ%3D%3D--cYKmQ7Xoco6etjgy--LWP33asZkd3yg8juNGqXDA%3D%3D';

// Rate-limit sweep (from the original server): 1.3s is the fastest cadence that
// sustains without 429s; 429 → 45s backoff.
const TICK_MS = 1300;
const RATE_LIMIT_BACKOFF_MS = 45_000;
const FETCH_TIMEOUT_MS = 10_000;
const COL_STALE_MS = 8_000;

const COMMON_FILTERS =
  'dexes=pump%2Craydium_launchpad%2Cmoonshot%2Cboop%2Cmeteora_virtual_curve%2Corca_wavebreak%2Craydium_clmm%2Craydium_cpmm' +
  '&platform=bonk%2Cbelieve%2Cmoonshotdbc%2Cjupiter%2Cbags%2Cwendev%2Cmayhem%2Cbonker%2Cprintr%2Cstonk' +
  '&pump_rewards_enabled=true&quote_token=wsol%2Cusdc%2Cusd1%2Ccustom';

// App-side field name → Photon query parameter. Each value is a {min?,max?} pair
// sent as `<param>_from` / `<param>_to`.
const FILTER_FIELDS = {
  age: 'age',
  holders: 'holders_count',
  tpHolders: 'tp_holders_count',
  mktCap: 'mkt_cap',
  buys: 'buys',
  freshPct: 'fresh_holding_perc',
  bundleHolders: 'bundle_holders_count',
  bundlePct: 'bundle_holding_perc',
};

// The app types market cap in thousands ("150" = $150,000) while Photon's mkt_cap
// counts whole dollars — without this, the query under-filtered by 1000x and only
// the phone's local echo hid the sub-floor tokens (alerts would have seen them).
const FIELD_MULT = { mktCap: 1000 };

// No default filters: the app filters the pushed snapshot locally (per column), so the
// server asks for the full column and nothing gets hidden upstream.
const DEFAULT_FILTERS = {
  col1: {},
  col3: {},
};

const COLS = [
  { key: 'col1', category: 'photon_new' },
  { key: 'col3', category: 'photon_graduated' },
];
const FALLBACK_TITLES = { col1: 'New', col3: 'Graduated' };

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function sanitizeColumnFilters(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const field of Object.keys(FILTER_FIELDS)) {
    const v = raw[field];
    if (!v || typeof v !== 'object') continue;
    const pair = {};
    for (const side of ['min', 'max']) {
      const val = v[side];
      if (typeof val === 'string' && /^\d+(\.\d+)?$/.test(val)) pair[side] = val;
    }
    if (pair.min || pair.max) out[field] = pair;
  }
  return out;
}

export function getPhotonFilters() {
  const entry = photonFilters.get('global');
  const stored = entry?.filters ?? entry ?? {};
  const out = {};
  for (const col of COLS) {
    const clean = sanitizeColumnFilters(stored[col.key]);
    out[col.key] = Object.keys(clean).length ? clean : DEFAULT_FILTERS[col.key] ?? {};
  }
  return out;
}

export function setPhotonFilters(raw) {
  const clean = {};
  for (const col of COLS) {
    if (raw?.[col.key]) clean[col.key] = sanitizeColumnFilters(raw[col.key]);
  }
  photonFilters.set('global', { filters: clean, updated_at: new Date().toISOString() });
  return getPhotonFilters();
}

function buildQuery(colKey) {
  const f = getPhotonFilters()[colKey] ?? {};
  const parts = [COMMON_FILTERS];
  for (const [field, param] of Object.entries(FILTER_FIELDS)) {
    const v = f[field];
    const mult = FIELD_MULT[field] ?? 1;
    if (v?.min) parts.push(`${param}_from=${Math.round(Number(v.min) * mult)}`);
    if (v?.max) parts.push(`${param}_to=${Math.round(Number(v.max) * mult)}`);
  }
  parts.push(`col=${colKey}`);
  return parts.join('&');
}

const HEADERS = {
  accept: '*/*',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  referer: 'https://photon-sol.tinyastro.io/en/memescope',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  get cookie() {
    return `_photon_ta=${process.env.PHOTON_TA || DEFAULT_TA}`;
  },
};

const colCache = {}; // colKey → { slice, savedAt }
let titles = null;
let seeded = {}; // colKey → boolean (first fetch seeds the seen-map silently)
let poller = null;
let inflight = null;
let backoffUntil = 0;
let fetchCount = 0;
let errorCount = 0;
let lastError = null;
let unauthorized = false;
let cycleTLS = null;

// Egress: the same saved URL + Settings switch FOMO uses (proxy-config.js). CycleTLS takes the
// proxy per request, so the poller re-reads it on every fetch — a toggle applies within ~1.3s.
let photonPreferProxy = true;
/** Transport of the current/last attempt ('proxy' | 'direct'). */
let photonTransport = 'direct';

onProxyChange(() => {
  // A new URL (or a fresh toggle) deserves a fresh transport choice.
  photonPreferProxy = true;
});

async function getCycleTLS() {
  if (!cycleTLS) cycleTLS = await initCycleTLS();
  return cycleTLS;
}

export async function closePhoton() {
  stopPoller();
  if (cycleTLS) {
    const c = cycleTLS;
    cycleTLS = null;
    try {
      await c.exit();
    } catch {}
  }
}

function toObj(data) {
  if (data == null) return null;
  if (typeof data === 'object' && !Buffer.isBuffer(data)) return data;
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Emits alerts for any token new to this column. */
function notifyColumn(colKey, items) {
  for (const it of items) {
    const a = it?.attributes;
    const address = a?.tokenAddress || a?.address;
    if (!address) continue;
    const col = COLS.find((c) => c.key === colKey);
    emitToken(col.category, {
      address,
      symbol: a.symbol ?? null,
      name: a.name ?? null,
      image: a.imgUrl ?? null,
      mcap: numOrNull(a.fdv),
      liquidity: numOrNull(a.cur_liq?.usd),
      volume: numOrNull(a.volume),
      holders: numOrNull(a.holders_count),
      kolCount: null,
      ageMinutes: null,
    });
  }
}

async function fetchOnce(colKey) {
  fetchCount += 1;
  const client = await getCycleTLS();
  const proxyUrl = getEffectiveProxy();
  const useProxy = Boolean(proxyUrl) && photonPreferProxy;
  photonTransport = useProxy ? 'proxy' : 'direct';
  const request = client(
    `${SEARCH_URL}?${buildQuery(colKey)}`,
    { client: 'chrome131', headers: HEADERS, ...(useProxy ? { proxy: proxyUrl } : {}) },
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
  } catch (err) {
    // Never reached the origin: flip the transport for the next tick — dead proxy → direct,
    // dead direct → the saved proxy — the way the FOMO socket does on a failed handshake.
    if (proxyUrl) photonPreferProxy = !photonPreferProxy;
    throw err;
  } finally {
    clearTimeout(timer);
    request.catch(() => {});
  }

  const status = Number(resp?.status) || 0;
  if (status === 429) {
    // Rate-limited on this IP: the proxy's IP is different, so prefer it next.
    if (!useProxy && proxyUrl) photonPreferProxy = true;
    backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    throw Object.assign(new Error('RATE_LIMITED'), { rateLimited: true });
  }
  if (status !== 200) {
    // Whatever went wrong, the transport that carried it didn't deliver: alternate —
    // dead proxy (status 0, 502, 407) → direct; Cloudflare on the direct IP (403) → proxy.
    if (proxyUrl) photonPreferProxy = !useProxy;
    throw new Error(`HTTP_${status}`);
  }

  const json = toObj(resp.data);
  if (!json) throw new Error('BAD_BODY');
  if (json.error) {
    if (String(json.error).includes('Unauthorized')) unauthorized = true;
    throw Object.assign(new Error(json.error), { unauthorized: true });
  }

  unauthorized = false;
  const slice = json.columns?.[colKey] ?? { data: [] };
  colCache[colKey] = { slice, savedAt: Date.now() };
  if (json.titles) titles = json.titles;

  const items = Array.isArray(slice?.data) ? slice.data : [];
  if (items.length) {
    if (!seeded[colKey]) {
      // First successful fetch: seed silently so booting doesn't fire the whole column.
      seedSeen(
        COLS.find((c) => c.key === colKey).category,
        items.map((it) => it?.attributes?.tokenAddress || it?.attributes?.address).filter(Boolean),
      );
      seeded[colKey] = true;
    } else {
      notifyColumn(colKey, items);
    }
  }

  broadcast('memescope', { event: 'memescope_updated', data: snapshotPayload() });
  return json;
}

function coalescedFetch(colKey) {
  if (inflight) return inflight.promise;
  const promise = fetchOnce(colKey)
    .catch((err) => {
      errorCount += 1;
      lastError = { message: String(err?.message || err), at: Date.now() };
      // A failed refresh re-pushes the payload with the error attached (snapshotPayload includes
      // `error` while it's <10s old) — even on a cold boot with no cache, so the app's pill turns
      // red and says WHY (RATE_LIMITED, HTTP_403, Unauthorized) instead of only watching the data
      // age climb in silence.
      broadcast('memescope', { event: 'memescope_updated', data: snapshotPayload() });
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  inflight = { colKey, promise };
  return promise;
}

function pollTick() {
  try {
    if (Date.now() < backoffUntil) return;
    if (inflight) return;
    // One column per tick, rotating: every column refreshes every ~2.6s.
    const col = COLS[photonNextCol % COLS.length];
    photonNextCol = (photonNextCol + 1) % COLS.length;
    void coalescedFetch(col.key);
  } catch {
    /* the timer must never crash */
  }
}

let photonNextCol = 0;

function startPoller() {
  if (poller) return;
  poller = setInterval(pollTick, TICK_MS);
}

function stopPoller() {
  if (poller) clearInterval(poller);
  poller = null;
}

function snapshotPayload() {
  const columns = {};
  let newest = 0;
  let any = false;
  for (const col of COLS) {
    columns[col.key] = colCache[col.key]?.slice ?? { data: [] };
    if (colCache[col.key]) {
      any = true;
      newest = Math.max(newest, colCache[col.key].savedAt);
    }
  }
  // Fresh failures travel with the payload (both branches): a cold boot that never got a 200
  // still has to say WHY on the app side, not just push an empty column list.
  const err = lastError && Date.now() - lastError.at < 10_000 ? { error: lastError.message } : {};
  if (!any) return { columns: {}, titles: {}, cached: false, ageMs: -1, savedAt: 0, ...err };
  return {
    columns,
    titles: titles ?? FALLBACK_TITLES,
    cached: true,
    ageMs: Date.now() - newest,
    savedAt: newest,
    ...err,
  };
}

/** Merged payload for the app; refreshes stale/cold columns on demand. Never throws. */
export async function getMemescope() {
  for (const col of COLS) {
    const missing = !colCache[col.key] || Date.now() - colCache[col.key].savedAt > COL_STALE_MS;
    if (missing && Date.now() >= backoffUntil) {
      await coalescedFetch(col.key);
      if (inflight) await inflight.promise;
    }
  }
  if (!COLS.some((c) => colCache[c.key])) {
    return { ...snapshotPayload(), error: lastError?.message || 'NO_DATA' };
  }
  return snapshotPayload();
}

/** Raw attributes for one address across the cached columns (app lookup). */
export function findPhotonToken(address) {
  if (!address) return null;
  for (const col of COLS) {
    const data = colCache[col.key]?.slice?.data;
    if (!Array.isArray(data)) continue;
    const hit = data.find((it) => (it?.attributes?.tokenAddress || it?.attributes?.address) === address);
    if (hit?.attributes) return hit.attributes;
  }
  return null;
}

export function getMemescopeStatus() {
  const colAges = {};
  for (const col of COLS) colAges[col.key] = colCache[col.key] ? Date.now() - colCache[col.key].savedAt : null;
  return {
    running: Boolean(poller),
    tickMs: TICK_MS,
    colAgesMs: colAges,
    fetchCount,
    errorCount,
    lastError,
    unauthorized,
    backoffRemainingMs: Math.max(0, backoffUntil - Date.now()),
    proxy: { ...getProxyStatus(), transport: photonTransport, preferProxy: photonPreferProxy },
  };
}

export function startPhotonPoller() {
  registerTopicProvider('memescope', () => {
    const payload = snapshotPayload();
    return payload.cached ? { event: 'memescope_updated', data: payload } : null;
  });
  startPoller();
  // Warm both columns right away instead of waiting for the rotation.
  void coalescedFetch('col1');
  setTimeout(() => void coalescedFetch('col3'), 300);
  console.log('[photon] poller started (col1 New + col3 Graduated, 1.3s rotation)');
}
