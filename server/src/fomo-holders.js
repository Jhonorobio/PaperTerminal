/**
 * FOMO HOLDER — inteligencia de holders FOMO para los tokens ACTIVOS del Track.
 *
 * El disparador NO es el feed de Trending: cada 30s se leen los tokens de
 * `trackTokens` con status === 'active' y se encola el que no se haya barrido
 * en el último minuto. Para cada token se hace UNA pasada:
 *
 *   1. GET /hodlers/top?tokens=[{address, networkId}]  → top ~100 holders
 *      con `costBasis` (lo que metió cada wallet) y su `user` (id, address,
 *      userHandle, clan).
 *   2. Sólo quedan los holders con costBasis ≥ $100 (decisión del usuario:
 *      "los que compraron 100 o más USD").
 *   3. Para `fomo_holder_pos`: GET /v2/users?userIds=… en lotes de 100 y se
 *      mira `pnl24h > 0` + el piso `pnl24hMinUsd` del dispositivo (FOMO no
 *      expone 7d por usuario; sólo 24h).
 *   4. Para `fomo_holder_top`: GET /v2/clans/leaderboard?window=24h|7d&limit=50
 *      (cache 15 min) y se mira si el clan del holder está en el top 50, o si
 *      el holder aparece en los topMembers de uno de esos clanes. El rank que
 *      se muestra es el del CLAN, no un ranking individual.
 *
 * El aviso sale UNA vez por token+categoría (fomo_holder_seen) y agrega a los
 * holders que cumplen (notify.js muestra los 3 mejores y el total): avisar una
 * vez por wallet son cientos de avisos por minuto. Si una respuesta viene
 * incompleta, la condición no se marca y un barrido posterior del mismo token
 * puede reintentar. Mientras el token siga activo en Track se revisa cada
 * minuto; si sale del Track (status 'done' o se borra), deja de escanearse.
 */

import { FOMO_API, fomoAuthedGetJson } from './fomo.js';
import {
  FOMO_HOLDER_POS_CATEGORY,
  FOMO_HOLDER_TOP_CATEGORY,
  emitFomoHolder,
  enabledFomoHolderCategories,
} from './notify.js';
import { trackTokens } from './stores.js';

const SOLANA_NETWORK_ID = 1399811149;
const HOLDER_MIN_USD = 100;
const USER_BATCH = 100;
const USER_TTL_MS = 10 * 60_000;
const USER_FAIL_TTL_MS = 2 * 60_000;
const BOARD_TTL_MS = 15 * 60_000;
const SCAN_DELAY_MS = 350;
/** Re-barrido de un token activo: cada minuto (el aviso no se repite). */
const SCANNED_TTL_MS = 60_000;
const SEEN_MAX = 5_000;
/** Cada cuánto se miran los tokens activos del Track (los nuevos entran acá). */
const TRACK_SWEEP_MS = 30_000;
/** Bound the backlog: a just-tracked token matters more than a 10-minute-old one. */
const QUEUE_MAX = 120;

const num = (value) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Un intento de holder: id de usuario, wallet, user completo y USD comprados. */
export function holderCandidates(topHolders) {
  if (!Array.isArray(topHolders)) return [];
  const out = [];
  const seen = new Set();
  for (const row of topHolders) {
    const user = row?.user && typeof row.user === 'object' ? row.user : null;
    const id = str(user?.id);
    const wallet = str(user?.address);
    const usd = num(row?.costBasis);
    if (!id || !wallet || usd == null || usd < HOLDER_MIN_USD) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      wallet,
      user,
      handle: str(user?.userHandle) ?? str(user?.displayName),
      usd: Math.round(usd),
    });
  }
  return out;
}

/**
 * Leaderboard de clanes → dos índices:
 *   clans:   clanId → { rank, name }
 *   members: userId → { rank, name }  (topMembers; cobertura parcial)
 */
export function parseClanBoard(leaderboard) {
  const clans = new Map();
  const members = new Map();
  if (!Array.isArray(leaderboard)) return { clans, members };
  leaderboard.forEach((clan, index) => {
    const id = str(clan?.id);
    if (!id) return;
    const rank = num(clan?.rank) ?? index + 1;
    if (rank < 1 || rank > 50) return;
    const name = str(clan?.name);
    clans.set(id, { rank, name });
    for (const member of Array.isArray(clan?.topMembers) ? clan.topMembers : []) {
      const userId = str(member?.user?.id);
      if (userId && !members.has(userId)) members.set(userId, { rank, name });
    }
  });
  return { clans, members };
}

/** Rank/nombre del clan del holder, o su puesto como topMember. */
export function clanHit(board, user, userId) {
  if (!board) return null;
  const clanId = str(user?.clan?.id);
  if (clanId && board.clans.has(clanId)) return board.clans.get(clanId);
  if (userId && board.members.has(userId)) return board.members.get(userId);
  return null;
}

/** Identidad mínima que notify.js necesita, armada desde un token del Track. */
export function trackTokenIdentity(tracked) {
  const snaps = Array.isArray(tracked?.snapshots) ? tracked.snapshots : [];
  const last = snaps[snaps.length - 1] ?? null;
  return {
    address: tracked?.address,
    symbol: tracked?.symbol ?? null,
    name: tracked?.name ?? null,
    image: tracked?.logo ?? null,
    logo: tracked?.logo ?? null,
    mcap: last?.mcap ?? null,
    volume: last?.volume ?? null,
    holders: last?.holders ?? null,
  };
}

/** Tokens que están activos en Track (status 'active'), listos para el scanner. */
export function trackHolderTargets() {
  return Object.values(trackTokens.getAll())
    .filter((tracked) => tracked?.status === 'active' && tracked.address)
    .map(trackTokenIdentity);
}

async function fetchTopHolders(address) {
  const tokens = [{ address, networkId: SOLANA_NETWORK_ID }];
  const url = `${FOMO_API}/hodlers/top?tokens=${encodeURIComponent(JSON.stringify(tokens))}`;
  const json = await fomoAuthedGetJson(url);
  if (!json) return null; // transport/auth failure → pump retries a later fresh event
  const rows = Array.isArray(json.responseObject) ? json.responseObject : [];
  const row = rows.find((item) => item?.tokenAddress === address) ?? rows[0];
  return holderCandidates(row?.topHolders);
}

const userCache = new Map(); // userId → { at, pnl24h }

function cachedPnl(id, now) {
  const hit = userCache.get(id);
  if (!hit) return { hit: false, value: null };
  const ttl = hit.pnl24h == null ? USER_FAIL_TTL_MS : USER_TTL_MS;
  if (now - hit.at > ttl) return { hit: false, value: null };
  return { hit: true, value: hit.pnl24h };
}

async function fetchUserPnl(ids) {
  const out = new Map();
  const now = Date.now();
  const missing = [];
  for (const id of ids) {
    const cached = cachedPnl(id, now);
    if (cached.hit) out.set(id, cached.value);
    else missing.push(id);
  }

  for (let i = 0; i < missing.length; i += USER_BATCH) {
    const chunk = missing.slice(i, i + USER_BATCH);
    const url = `${FOMO_API}/v2/users?${chunk.map((id) => `userIds=${encodeURIComponent(id)}`).join('&')}`;
    const json = await fomoAuthedGetJson(url);
    const users = Array.isArray(json?.responseObject?.users) ? json.responseObject.users : null;
    const returned = new Set();
    if (users) {
      for (const user of users) {
        const id = str(user?.id);
        if (!id) continue;
        const pnl24h = num(user?.pnl24h);
        userCache.set(id, { at: now, pnl24h });
        out.set(id, pnl24h);
        returned.add(id);
      }
    }
    for (const id of chunk) {
      if (returned.has(id)) continue;
      // No vino en la respuesta (usuario privado/borrado o request fallido):
      // cache corto para no repetir el lote en cada token durante 10 min.
      userCache.set(id, { at: now, pnl24h: null });
      out.set(id, null);
    }
  }

  if (userCache.size > SEEN_MAX) {
    const ordered = [...userCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [id] of ordered.slice(0, userCache.size - SEEN_MAX)) userCache.delete(id);
  }
  return out;
}

async function fetchClanBoard(window) {
  const url = `${FOMO_API}/v2/clans/leaderboard?window=${window}&limit=50`;
  const json = await fomoAuthedGetJson(url);
  const leaderboard = json?.responseObject?.leaderboard;
  if (!Array.isArray(leaderboard)) return null;
  return parseClanBoard(leaderboard);
}

let boardCache = { at: 0, day: null, week: null };
let boardsInflight = null;

async function ensureBoards() {
  const fresh = boardCache.day && boardCache.week && Date.now() - boardCache.at < BOARD_TTL_MS;
  if (fresh) return boardCache;
  if (boardsInflight) return boardsInflight;
  boardsInflight = (async () => {
    const [day, week] = await Promise.all([fetchClanBoard('24h'), fetchClanBoard('7d')]);
    boardCache = {
      at: day || week ? Date.now() : 0,
      day: day ?? boardCache.day,
      week: week ?? boardCache.week,
    };
    return boardCache;
  })().finally(() => {
    boardsInflight = null;
  });
  return boardsInflight;
}

const queue = [];
const queued = new Set();
const scanned = new Map(); // address → at (no repetir el mismo token antes de 1 min)
let running = false;
let started = false;
let scans = 0;
let alerts = 0;
let dropped = 0;
let lastScanAt = 0;
let lastSweepAt = 0;
let lastError = null;
let sweepTimer = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function trimScanned() {
  if (scanned.size <= SEEN_MAX) return;
  const ordered = [...scanned.entries()].sort((a, b) => a[1] - b[1]);
  for (const [address] of ordered.slice(0, scanned.size - SEEN_MAX)) scanned.delete(address);
}

function enqueue(token) {
  if (!token?.address) return;
  if (!enabledFomoHolderCategories().size) return;
  const prev = scanned.get(token.address);
  if (prev != null && Date.now() - prev < SCANNED_TTL_MS) return;
  if (queued.has(token.address)) return;

  while (queue.length >= QUEUE_MAX) {
    const old = queue.shift();
    if (!old) break;
    queued.delete(old.address);
    scanned.delete(old.address);
    dropped += 1;
  }

  scanned.set(token.address, Date.now());
  trimScanned();
  queued.add(token.address);
  queue.push({ ...token });
  void pump();
}

async function scanToken(token) {
  const enabled = enabledFomoHolderCategories();
  if (!enabled.size) return 0;
  const needPos = enabled.has(FOMO_HOLDER_POS_CATEGORY);
  const needTop = enabled.has(FOMO_HOLDER_TOP_CATEGORY);

  lastScanAt = Date.now();
  scans += 1;

  const holders = await fetchTopHolders(token.address);
  if (!holders) throw new Error('FOMO holders unavailable');
  if (!holders.length) return 0;

  const pnlById = needPos ? await fetchUserPnl(holders.map((holder) => holder.id)) : new Map();
  const boards = needTop ? await ensureBoards() : null;

  // One event row per holder; notify.js aggregates them into ONE alert per
  // token+category (a per-wallet alert here would be hundreds per minute).
  const events = holders.map((holder) => {
    const top24h = needTop ? clanHit(boards?.day, holder.user, holder.id) : null;
    const top7d = needTop ? clanHit(boards?.week, holder.user, holder.id) : null;
    return {
      address: holder.wallet,
      userName: holder.handle,
      usd: holder.usd,
      pnl24h: needPos ? (pnlById.get(holder.id) ?? null) : null,
      top24hRank: top24h?.rank ?? null,
      top24hClan: top24h?.name ?? null,
      top7dRank: top7d?.rank ?? null,
      top7dClan: top7d?.name ?? null,
    };
  });

  let emitted = 0;
  if (needPos && emitFomoHolder(token, events, FOMO_HOLDER_POS_CATEGORY)) emitted += 1;
  if (needTop && emitFomoHolder(token, events, FOMO_HOLDER_TOP_CATEGORY)) emitted += 1;
  return emitted;
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const token = queue.shift();
    try {
      alerts += await scanToken(token);
      lastError = null;
    } catch (err) {
      lastError = String(err?.message ?? err).slice(0, 200);
      // Transient failure: a later sweep of the still-active token retries.
      scanned.delete(token.address);
    } finally {
      queued.delete(token.address);
    }
    if (queue.length) await delay(SCAN_DELAY_MS);
  }
  running = false;
}

/**
 * Cada 30s: tokens activos del Track que no se hayan barrido en el último minuto. `enqueue`
 * vuelve a chequear categorías/cola/`scanned`, así que esto es barato cuando no
 * hay nada nuevo o las alertas están apagadas.
 */
function sweepActiveTrackTokens() {
  lastSweepAt = Date.now();
  if (!enabledFomoHolderCategories().size) return;
  for (const token of trackHolderTargets()) {
    const prev = scanned.get(token.address);
    if (prev != null && Date.now() - prev < SCANNED_TTL_MS) continue;
    enqueue(token);
  }
}

export function startFomoHolders() {
  if (started) return;
  started = true;
  sweepActiveTrackTokens();
  sweepTimer = setInterval(sweepActiveTrackTokens, TRACK_SWEEP_MS);
  sweepTimer.unref?.();
  console.log('[fomo-holders] scanning active Track tokens (top holders ≥$100 · 24h PnL · clan top 50)');
}

export function stopFomoHolders() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  started = false;
}

export function getFomoHolderStatus() {
  return {
    started,
    running,
    source: 'track',
    activeTrackTokens: trackHolderTargets().length,
    sweepMs: TRACK_SWEEP_MS,
    rescanMs: SCANNED_TTL_MS,
    queue: queue.length,
    scanned: scanned.size,
    scans,
    alerts,
    dropped,
    lastSweepAt: lastSweepAt || null,
    lastScanAt: lastScanAt || null,
    lastError,
    boardsAt: boardCache.at || null,
    enabled: [...enabledFomoHolderCategories()],
  };
}
