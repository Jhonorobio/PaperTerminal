/**
 * FOMO (fomo.family) feed server — ported and trimmed from
 * `server con APIS/src/services/fomo-ws.js` + `fomo-auth.js`.
 *
 * One socket to wss://prod-api.fomo.family/ws, carrying both subscriptions:
 *
 *   ← { type: 'challenge' }            → { type: 'challengeResponse', jwt }
 *   ← { type: 'challengeAccepted' }     → subscribe graduated_tokens / trending_tokens
 *   ← { type: 'data', topicType, payload: { kind: 'snapshot'|'update'|'remove' } }
 *
 * The app NEVER talks to FOMO: it subscribes to the WS topics `fomo` and
 * `fomo_trending` here and gets everything pushed. Alerts fire from the same
 * stream: every newly-seen token goes through `notify.js` (WS panel + push).
 *
 * The first snapshot after subscribe seeds the seen-map silently, so connecting
 * does not fire 90 pushes.
 */

import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { fomoFilters } from './stores.js';
import { broadcast, registerTopicProvider } from './ws.js';
import { emitToken, seedSeen } from './notify.js';
import { pulseEnrich } from './pulse.js';
import { JsonStore } from './json-store.js';

// ── proxy config (persisted; the app sets it via PUT /api/fomo/proxy) ────────

const PROXY_PROTOCOLS = ['http:', 'https:', 'socks:', 'socks4:', 'socks5:'];
const configStore = new JsonStore('fomo-config');

/** '' → '' (direct); a bare `host:port` gets http://; throws on junk. */
function normalizeProxy(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`proxy inválido: ${v.slice(0, 80)}`);
  }
  if (!PROXY_PROTOCOLS.includes(u.protocol)) {
    throw new Error(`protocolo no soportado: ${u.protocol} (usá http:// o socks5://)`);
  }
  if (!u.hostname) throw new Error('proxy sin host');
  return withScheme;
}

function getProxyUrl() {
  const stored = configStore.get('proxy');
  if (stored != null && stored !== '') return normalizeProxy(stored);
  return process.env.FOMO_WS_PROXY ? normalizeProxy(process.env.FOMO_WS_PROXY) : '';
}

/**
 * Saves (or clears, with '') the FOMO egress proxy and reconnects the socket so
 * it applies immediately. The store wins over the env var.
 */
export function setFomoProxy(raw) {
  const normalized = normalizeProxy(raw); // '' allowed → direct
  configStore.set('proxy', normalized);
  configStore.set('updated_at', new Date().toISOString());
  preferProxy = Boolean(normalized);
  if (ws) {
    try {
      ws.close();
    } catch {} // close → reconnect with the new transport
  } else {
    scheduleReconnect();
  }
  return getFomoProxyStatus();
}

export function getFomoProxyStatus() {
  let url = '';
  try {
    url = getProxyUrl();
  } catch {
    url = '';
  }
  return { url, enabled: Boolean(url), transport: currentTransport, preferProxy };
}

// ── Privy auth ───────────────────────────────────────────────────────────────

const PRIVY_APP_ID = 'cm6h485o300n3zj9yl6vpedq7'; // FOMO's Privy app (jwt aud)
const SESSIONS_URL = 'https://auth.privy.io/api/v1/sessions';
const MIN_REMAINING_MS = 120_000;

const authStore = new JsonStore('fomo-auth');

function getRefreshToken() {
  return process.env.FOMO_REFRESH_TOKEN || authStore.get('refresh_token') || null;
}

let accessToken = null;
let accessExpMs = 0;
let inflight = null;

function decodeExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp) * 1000 || 0;
  } catch {
    return 0;
  }
}

function getAccessToken({ force = false } = {}) {
  if (!force && accessToken && Date.now() < accessExpMs - MIN_REMAINING_MS) return Promise.resolve(accessToken);
  if (inflight) return inflight;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return Promise.reject(new Error('FOMO: no refresh token (FOMO_REFRESH_TOKEN)'));
  inflight = (async () => {
    try {
      const res = await fetch(SESSIONS_URL, {
        method: 'POST',
        headers: { 'privy-app-id': PRIVY_APP_ID, 'Content-Type': 'application/json', Accept: 'application/json', origin: 'https://fomo.family' },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.token) throw new Error(`FOMO refresh failed: HTTP ${res.status}`);
      accessToken = body.token;
      accessExpMs = decodeExp(body.token) || Date.now() + 3_600_000;
      // Privy may rotate someday — persist the new one when it does.
      if (typeof body.refresh_token === 'string' && body.refresh_token && body.refresh_token !== refreshToken) {
        authStore.set('refresh_token', body.refresh_token);
      }
      return accessToken;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// ── Feed config ──────────────────────────────────────────────────────────────

const FOMO_WS_URL = 'wss://prod-api.fomo.family/ws';
const SOLANA_TOPIC_ID = '1399811149';
const RECONNECT_MS = 3_000;
const PING_MS = 30_000;
const PONG_TIMEOUT_MS = 15_000;
const DATA_TIMEOUT_MS = 120_000;
/** Upstream sends ~100 msg/s — batch app broadcasts into one push per window. */
const PUSH_MS = 500;
const MAX_TOKENS = 5_000;

/** Filters (per feed): age minutes, mcap USD, KOL count, limit. */
const FILTER_FIELDS = { age: 'ageMinMin/ageMaxMin', mcap: 'mcapMin/mcapMax', kol: 'kolMin/kolMax', limit: 'limit' };

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function normalize(item, nowMs) {
  const it = item && typeof item === 'object' ? item : {};
  const t = it.token && typeof it.token === 'object' ? it.token : {};
  const address = str(t.address);
  if (!address) return null;
  const info = t.info && typeof t.info === 'object' ? t.info : {};
  const launchpad = t.launchpad && typeof t.launchpad === 'object' ? t.launchpad : {};
  return {
    address,
    symbol: str(t.symbol)?.replace(/^\$/, '').toUpperCase() ?? null,
    name: str(t.name),
    image: str(info.imageThumbUrl),
    launchpad: str(launchpad.launchpadName),
    createdAt: num(it.createdAt), // unix seconds
    mcap: num(it.marketCap),
    price: num(it.priceUSD),
    vol24: num(it.volume24),
    change24: num(it.change24),
    holders: num(it.holders),
    updatedAt: nowMs,
  };
}

const FEEDS = [
  { id: 'graduated', category: 'fomo_graduated', topicType: 'graduated_tokens', topic: 'fomo', event: 'fomo_updated', ranked: false },
  { id: 'trending', category: 'fomo_trending', topicType: 'trending_tokens', topic: 'fomo_trending', event: 'fomo_trending_updated', ranked: true },
];

const maps = { graduated: new Map(), trending: new Map() };
const snapshotCount = { graduated: 0, trending: 0 };
const lastMsgAt = { graduated: 0, trending: 0 };

let ws = null;
let running = false;
let reconnectTimer = null;
let pingTimer = null;
let pongTimer = null;
let lastPongAt = 0;
let lastError = null;
let authFailures = 0;
/** With a proxy configured, try it first; flip to direct only if its handshake fails. */
let preferProxy = true;
/** Transport of the current/last attempt ('proxy' | 'direct'). */
let currentTransport = 'direct';

// ── app-facing reads ─────────────────────────────────────────────────────────

function ordered(feedId) {
  const list = [...maps[feedId].values()];
  return FEEDS.find((f) => f.id === feedId).ranked
    ? list.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
    : list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function sanitizeFeedFilters(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const field of ['ageMinMin', 'ageMaxMin', 'mcapMin', 'mcapMax', 'kolMin', 'kolMax']) {
    const v = numOrNull(raw[field]);
    if (v != null) out[field] = v;
  }
  const limit = numOrNull(raw.limit);
  if (limit != null) out.limit = Math.min(Math.max(Math.floor(limit), 1), 1000);
  return out;
}

export function getFomoFilters() {
  const entry = fomoFilters.get('global');
  const stored = sanitizeFeedFilters(entry?.filters ?? entry ?? {});
  return { graduated: stored.graduated ?? {}, trending: stored.trending ?? {} };
}

export function setFomoFilters(raw) {
  const clean = {};
  for (const feed of ['graduated', 'trending']) {
    if (raw?.[feed]) clean[feed] = sanitizeFeedFilters(raw[feed]);
  }
  fomoFilters.set('global', { filters: clean, updated_at: new Date().toISOString() });
  return getFomoFilters();
}

const AGE_ENRICH_CAP = 100;
const KOL_ENRICH_CAP = 100;

/** Filtered read for the app's HTTP fallback and for WS topic providers. */
async function readFeed(feedId, filters) {
  const nowSec = Math.floor(Date.now() / 1000);
  const feed = FEEDS.find((f) => f.id === feedId);
  let list = [...maps[feedId].values()];

  if (filters.mcapMin != null || filters.mcapMax != null) {
    list = list.filter((t) => t.mcap != null && (filters.mcapMin == null || t.mcap >= filters.mcapMin) && (filters.mcapMax == null || t.mcap <= filters.mcapMax));
  }
  if (filters.ageMinMin != null || filters.ageMaxMin != null) {
    await pulseEnrich(list.slice(0, AGE_ENRICH_CAP), { age: true });
    const minSec = filters.ageMinMin != null ? filters.ageMinMin * 60 : null;
    const maxSec = filters.ageMaxMin != null ? filters.ageMaxMin * 60 : null;
    list = list.filter((t) => t.createdAt != null && (minSec == null || nowSec - t.createdAt >= minSec) && (maxSec == null || nowSec - t.createdAt <= maxSec));
  }
  list.sort(feed.ranked ? (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) : (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (filters.kolMin != null || filters.kolMax != null) {
    await pulseEnrich(list.slice(0, KOL_ENRICH_CAP), { kol: true });
    list = list.filter((t) => t.kolCount != null && (filters.kolMin == null || t.kolCount >= filters.kolMin) && (filters.kolMax == null || t.kolCount <= filters.kolMax));
  }
  const cap = Math.min(Math.max(Math.floor(filters.limit ?? 200), 1), 1000);
  return { tokens: list.slice(0, cap), total: list.length, savedAt: Date.now() };
}

export async function getFomoGraduated(filters) {
  return readFeed('graduated', { ...getFomoFilters().graduated, ...sanitizeFeedFilters(filters) });
}

export async function getFomoTrending(filters) {
  return readFeed('trending', { ...getFomoFilters().trending, ...sanitizeFeedFilters(filters) });
}

export function getFomoStatus() {
  const feedStatus = (id) => ({ count: maps[id].size, snapshots: snapshotCount[id], lastMsgAgeMs: lastMsgAt[id] ? Date.now() - lastMsgAt[id] : null });
  return {
    connected: Boolean(ws && ws.readyState === 1),
    live: Boolean(ws && ws.readyState === 1 && (Date.now() - (lastMsgAt.graduated || 0) < 60_000 || Date.now() - (lastMsgAt.trending || 0) < 60_000)),
    authFailures,
    lastError,
    proxy: getFomoProxyStatus(),
    graduated: feedStatus('graduated'),
    trending: feedStatus('trending'),
  };
}

// ── WS plumbing ──────────────────────────────────────────────────────────────

function send(obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* closed mid-send */
    }
  }
}

function queueBroadcast(feed) {
  if (feed.pushTimer) return;
  feed.pushTimer = setTimeout(() => {
    feed.pushTimer = null;
    // Full list, snapshot semantics: the app replaces its map, so removals and
    // reorderings land without needing a separate delta protocol.
    broadcast(feed.topic, { event: feed.event, data: { tokens: ordered(feed.id).slice(0, 250), savedAt: Date.now(), snapshot: true } });
  }, PUSH_MS);
}

function feedOf(topicType) {
  return FEEDS.find((f) => f.topicType === topicType) ?? FEEDS[0];
}

function applyData(feed, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const nowMs = Date.now();
  lastMsgAt[feed.id] = nowMs;

  if (p.kind === 'snapshot' && Array.isArray(p.tokens)) {
    const map = maps[feed.id];
    map.clear();
    const fresh = [];
    p.tokens.forEach((item, i) => {
      const rec = normalize(item, nowMs);
      if (!rec) return;
      if (feed.ranked) rec.rank = i;
      const prev = map.get(rec.address);
      if (prev?.kolCount != null && rec.kolCount == null) rec.kolCount = prev.kolCount;
      if (prev?.createdAt != null && rec.createdAt == null) rec.createdAt = prev.createdAt;
      map.set(rec.address, rec);
      if (!prev) fresh.push(rec.address);
    });
    snapshotCount[feed.id] += 1;
    // The very first snapshot after (re)connect: seed silently, never alert on reconnect.
    if (snapshotCount[feed.id] <= 1) {
      seedSeen(feed.category, [...map.keys()]);
    } else {
      for (const address of fresh) {
        const rec = map.get(address);
        if (rec) emitToken(feed.category, alertToken(rec, nowMs));
      }
    }
    broadcast(feed.topic, { event: feed.event, data: { tokens: ordered(feed.id).slice(0, 250), savedAt: nowMs, snapshot: true } });
  } else if (p.kind === 'update' && p.update) {
    const rec = normalize(p.update, nowMs);
    const map = maps[feed.id];
    if (rec) {
      const prev = map.get(rec.address);
      if (feed.ranked && typeof p.index === 'number') rec.rank = p.index;
      else if (feed.ranked && prev?.rank != null) rec.rank = prev.rank;
      if (prev?.kolCount != null && rec.kolCount == null) rec.kolCount = prev.kolCount;
      if (prev?.createdAt != null && rec.createdAt == null) rec.createdAt = prev.createdAt;
      map.set(rec.address, rec);
      if (!prev) emitToken(feed.category, alertToken(rec, nowMs));
      queueBroadcast(feed);
    }
  } else if (p.kind === 'remove' && typeof p.tokenKey === 'string') {
    const address = p.tokenKey.split(':')[0];
    if (maps[feed.id].delete(address)) queueBroadcast(feed);
  }
}

/** Feed record → the shape notify.js evaluates. */
function alertToken(rec, nowMs) {
  return {
    address: rec.address,
    symbol: rec.symbol,
    name: rec.name,
    image: rec.image,
    mcap: rec.mcap,
    liquidity: null,
    volume: rec.vol24,
    holders: rec.holders,
    kolCount: rec.kolCount ?? null,
    ageMinutes: rec.createdAt != null ? Math.max(0, Math.floor((nowMs / 1000 - rec.createdAt) / 60)) : null,
  };
}

function connect() {
  if (!running) return;
  if (!getRefreshToken()) {
    lastError = 'no refresh token — set FOMO_REFRESH_TOKEN';
    scheduleReconnect();
    return;
  }

  const proxyUrl = (() => {
    try {
      return getProxyUrl();
    } catch {
      return '';
    }
  })();
  const useProxy = Boolean(proxyUrl) && preferProxy;
  currentTransport = useProxy ? 'proxy' : 'direct';

  let agent;
  if (useProxy) {
    try {
      agent = proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
    } catch (err) {
      lastError = `bad proxy: ${err.message}`;
      scheduleReconnect();
      return;
    }
  }

  let socket;
  try {
    socket = new WebSocket(FOMO_WS_URL, {
      ...(agent ? { agent } : {}),
      handshakeTimeout: 15_000,
      headers: { origin: 'https://fomo.family', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36' },
    });
  } catch (err) {
    lastError = err.message;
    scheduleReconnect();
    return;
  }
  ws = socket;
  lastPongAt = Date.now();

  // Handshake never completed → try the other transport next attempt (a dead
  // proxy falls back to direct; a 432'd direct goes back to proxy).
  let opened = false;
  let flipped = false;
  const flipTransport = () => {
    if (!flipped && !opened && proxyUrl) {
      flipped = true;
      preferProxy = !preferProxy;
    }
  };

  socket.on('open', () => {
    opened = true;
    console.log(`[fomo] connected (${currentTransport}${currentTransport === 'proxy' ? ` via ${proxyUrl.replace(/\/\/.*@/, '//***@')}` : ''})`);
  });

  socket.on('message', (raw) => {
    if (ws !== socket) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'challenge':
        getAccessToken()
          .then((jwt) => {
            if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'challengeResponse', jwt }));
          })
          .catch((err) => {
            lastError = err.message;
            authFailures++;
            try {
              socket.close();
            } catch {}
          });
        break;
      case 'challengeAccepted':
        for (const feed of FEEDS) send({ type: 'subscribe', topicType: feed.topicType, topicId: SOLANA_TOPIC_ID });
        console.log('[fomo] authenticated — subscribed to graduated + trending');
        break;
      case 'error':
        lastError = typeof msg.message === 'string' ? msg.message : JSON.stringify(msg).slice(0, 300);
        console.log('[fomo] server error:', lastError);
        break;
      case 'data':
        applyData(feedOf(msg.topicType), msg.payload);
        break;
      default:
        break;
    }
  });

  socket.on('pong', () => {
    lastPongAt = Date.now();
  });

  socket.on('close', (code) => {
    if (ws !== socket) return;
    ws = null;
    flipTransport();
    // 1008 = policy violation: the JWT was rejected — mint a fresh one next time.
    if (code === 1008) {
      authFailures++;
      getAccessToken({ force: true }).catch(() => {});
    }
    console.log(`[fomo] disconnected (${code}) — reconnecting…`);
    scheduleReconnect();
  });

  socket.on('error', (err) => {
    lastError = err.message;
    flipTransport();
  });
}

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

/** Long silence on an open socket = zombie (FOMO's list always has activity). */
function watchdog() {
  if (!running || !ws || ws.readyState !== 1) return;
  const now = Date.now();
  const newest = Math.max(lastMsgAt.graduated, lastMsgAt.trending);
  if (newest && now - newest > DATA_TIMEOUT_MS) {
    console.log('[fomo] feed silent — restarting socket');
    try {
      ws.close();
    } catch {}
    return;
  }
  if (now - lastPongAt > PING_MS + PONG_TIMEOUT_MS) {
    try {
      ws.close();
    } catch {}
    return;
  }
  try {
    ws.ping();
  } catch {}
}

export function startFomoWatcher() {
  if (running) return;
  running = true;
  connect();
  pingTimer = setInterval(watchdog, PING_MS);
  // Topic providers: an app that subscribes gets the current list immediately.
  for (const feed of FEEDS) {
    registerTopicProvider(feed.topic, () => {
      const list = ordered(feed.id).slice(0, 250);
      if (!list.length) return null;
      return { event: feed.event, data: { tokens: list, savedAt: Date.now(), snapshot: true } };
    });
  }
  console.log('[fomo] watcher started (Solana: graduated + trending)');
}

export function stopFomoWatcher() {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pingTimer) clearInterval(pingTimer);
  reconnectTimer = null;
  pingTimer = null;
  try {
    ws?.close();
  } catch {}
  ws = null;
}
