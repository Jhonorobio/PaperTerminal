/**
 * Alert evaluation — the shared brain behind both feeds.
 *
 * A token enters with `emitToken(category, token)`. If the address is new for
 * that category, every device subscribed to the category gets:
 *   1. a WS frame on its private topic `alerts:{deviceId}` — the app paints its
 *      own floating panel with it, from any screen;
 *   2. an Expo push — for when the app is closed or backgrounded.
 * A history entry is written either way, so the app can show what fired.
 *
 * Filters come from the feed screens, one configuration for the list and the alert:
 *   - FOMO: the stream carries everything, so the stored feed filters (pushed by the
 *     app via PUT /api/fomo/filters) gate the token before any device sees it;
 *   - Photon: no check needed here — photon.js queried the column with those same
 *     filters, so only tokens that pass ever reach emitToken.
 * Per-device filters (the old alerts-screen config) are no longer read.
 */

import { notificationConfig, notificationHistory, fomoSeen, photonSeen, trackEntrySeen } from './stores.js';
import { getFomoFilters } from './fomo-filter-store.js';
import { isValidPushToken, sendPush } from './push.js';
import { sendToDevice } from './ws.js';

const HISTORY_MAX = 500;
const SEEN_MAX = 5000;

const LABELS = {
  fomo_graduated: 'FOMO Graduados',
  fomo_trending: 'FOMO Trending',
  pump_trending: 'Pump Trending',
  photon_new: 'Photon New',
  photon_graduated: 'Photon Graduated',
  // Alertas del Track (ver TRACK_ENTRY_CATEGORIES): se evalúan en la entrada.
  track_cal_chat: 'Track CAL+CHAT',
  track_chat_tesis: 'Track CHAT+TESIS',
  track_chat: 'Track CHAT',
  track_tesis: 'Track TESIS',
  track_top: 'Track TOP',
  track_cal100_pos: 'Track CAL100+',
};

/**
 * The FOMO screen's bounds over the alert token's fields. A bound on data the token
 * doesn't carry excludes it — the same rule readFeed applies to the visible list.
 */
function passesFeedFilters(category, token) {
  const feed = getFomoFilters()[category === 'fomo_graduated' ? 'graduated' : 'trending'];
  if (!feed) return true;
  const bounds = [
    [feed.mcapMin, feed.mcapMax, token.mcap],
    [feed.kolMin, feed.kolMax, token.kolCount],
    [feed.ageMinMin, feed.ageMaxMin, token.ageMinutes],
  ];
  for (const [min, max, value] of bounds) {
    if (min == null && max == null) continue;
    if (value == null) return false;
    if (min != null && value < min) return false;
    if (max != null && value > max) return false;
  }
  return true;
}

function bodyOf(token) {
  const parts = [];
  if (token.mcap != null) parts.push(`MCap $${compact(token.mcap)}`);
  if (token.volume != null) parts.push(`Vol $${compact(token.volume)}`);
  if (token.liquidity != null) parts.push(`Liq $${compact(token.liquidity)}`);
  return parts.join(' · ') || 'Nuevo token que pasó tus filtros';
}

const compact = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : n.toFixed(2));

/**
 * Marks an address as processed for a category without alerting — used to seed
 * the seen-map with a feed's first snapshot, so connecting doesn't fire 90 pushes.
 */
export function seedSeen(category, addresses) {
  const store = category.startsWith('fomo') ? fomoSeen : photonSeen;
  const all = store.getAll();
  for (const address of addresses) {
    const key = `${category}:${address}`;
    if (!all[key]) store.set(key, { at: Date.now(), seeded: true });
  }
}

/** True when the address was already processed for this category. */
export function isSeen(category, address) {
  const store = category.startsWith('fomo') ? fomoSeen : photonSeen;
  return store.has(`${category}:${address}`);
}

/**
 * Evaluates one token against every device subscribed to `category`.
 * Returns true when it was new (regardless of matching devices).
 */
export function emitToken(category, token) {
  const store = category.startsWith('fomo') ? fomoSeen : photonSeen;
  const key = `${category}:${token.address}`;
  if (store.has(key)) return false;
  store.set(key, { at: Date.now() });

  // Keep the seen map bounded.
  const all = store.getAll();
  const keys = Object.keys(all);
  if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX)) store.delete(k);

  // FOMO's stream is unfiltered, so the feed's own bounds gate it here (Photon's were
  // applied by its column query). The token stays seen either way — loosening a filter
  // later must not re-alert tokens that already passed through.
  if (category.startsWith('fomo') && !passesFeedFilters(category, token)) return true;

  const devices = Object.values(notificationConfig.getAll()).filter((d) => d?.categories?.[category]);
  for (const device of devices) {
    const entry = notificationHistory.add({
      device_id: device.device_id,
      category,
      address: token.address,
      chain: 'sol',
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      logo: token.image ?? null,
      mcap: token.mcap ?? null,
      liq: token.liquidity ?? null,
      vol24h: token.volume ?? null,
      holders: token.holders ?? null,
      kolCount: token.kolCount ?? null,
      ageMinutes: token.ageMinutes ?? null,
      notified_at: new Date().toISOString(),
    });

    // 1. In-app panel: private WS topic, painted by the app wherever it is.
    sendToDevice(device.device_id, { event: 'alert', data: entry });

    // 2. System push: for when the app is not in the foreground.
    if (isValidPushToken(device.push_token)) {
      void sendPush(device.push_token, {
        title: `${token.symbol || token.name || 'Token'} — ${LABELS[category]}`,
        body: bodyOf(token),
        data: { address: token.address, chain: 'sol', symbol: token.symbol ?? null, category },
      }).catch(() => {});
    }
  }

  trimHistory();
  return true;
}

/**
 * TRACK entry alerts — cada regla se evalúa en el snapshot de ENTRADA (el primer
 * minuto del token) y dispara UNA vez por address y categoría.
 *
 * Medidas el 17/oct sobre el dump de prod (486 tokens / 8.108 snapshots,
 * horizontes fijos 5/10/20/30 min, resultado = pico sobre el precio de entrada).
 * Medido EN LA ENTRADA, que es lo operable:
 *   track_cal_chat   CAL [$100,$500) ≥1 + chat ≥N wallets — n=28: 96% sube,
 *                    18% x2, +30% pico a 10 min. Confirmación: "sube" casi seguro.
 *   track_chat_tesis chat ≥N + ≥M tesis — n=22: 95% sube, 27% x2, +65% pico.
 *   track_chat       chat ≥N wallets — n=75 (N=2): 86% sube, 22% x2, +32% pico.
 *   track_tesis      ≥M tesis — n=59: 81% sube pero 12% x2 (sube sí, upside no).
 *   track_top        TOP·D ≥N — n=69: 80% sube, 23% x2, +36% pico.
 *
 * Los umbrales (N/M) son POR DISPOSITIVO (`device.params`, editables en la
 * pantalla Notificaciones); los defaults son los medidos.
 */
export const TRACK_ENTRY_CATEGORIES = ['track_cal_chat', 'track_chat_tesis', 'track_chat', 'track_tesis', 'track_top'];

/**
 * TRACK CAL100+ — la entrada CAL100 (fuente 10, ver track.js) cuando el barrido
 * le resuelve el PnL y la deja EN VERDE.
 *
 * No vive en TRACK_ENTRY_CATEGORIES por una razón dura: las de arriba se evalúan
 * en el snapshot de ENTRADA, y acá el dato no está en el snapshot — el PnL lo trae
 * sweepCall100 segundos (o un par de minutos) después, 2 requests por wallet y 3
 * en paralelo. ESE es el momento en que se conoce el signo, así que el aviso sale
 * desde el barrido (ver el gancho en track.js).
 *
 * Sin umbral a propósito (decisión del usuario): avisa CADA wallet que resuelve en
 * verde, sin piso de monto ni de PnL. Medido en prod el 18/oct: ~28 wallets
 * positivas por hora de track —es la categoría más ruidosa de todas; si cansa, el
 * piso natural es un conteo por token, como las otras cinco.
 *
 * "Verde" = alguna ventana > 0 (1d o 1w), la MISMA regla que pinta la UI (ver
 * WindowPnl en la app y cal100Cell en el panel): la ventana en rojo no cuenta.
 * El "una sola vez" es por token+wallet, no por token: el mismo token avisa por
 * 2, 3, … wallets porque la unidad es la entrada, no el token.
 */
export const TRACK_CAL100_CATEGORY = 'track_cal100_pos';

/** Umbrales saneados (defaults medidos, rangos útiles) desde un objeto crudo. */
export function sanitizeTrackParams(raw) {
  const num = (v, def, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), max) : def;
  };
  return {
    chatWalletsMin: num(raw?.chatWalletsMin, 2, 50),
    tesisMin: num(raw?.tesisMin, 1, 20),
    topMin: num(raw?.topMin, 1, 10),
  };
}

/** Umbrales de un dispositivo, con los defaults medidos y saneados al rango útil. */
export function trackParamsOf(device) {
  return sanitizeTrackParams(device?.params);
}

/** ready = la fuente ya trajo el dato. Si no, el token NO se marca (se reintenta). */
const TRACK_RULES = {
  track_cal_chat: {
    ready: (t) => t.callout100to500 != null && t.chatWallets != null,
    hit: (t, p) => t.callout100to500 >= 1 && t.chatWallets >= p.chatWalletsMin,
    body: (t, p) => `CAL [$100-500) ×${t.callout100to500} · chat ${t.chatWallets} wallets (≥${p.chatWalletsMin}) · MCap $${compact(t.mcap ?? 0)}`,
  },
  track_chat_tesis: {
    ready: (t) => t.chatWallets != null && t.thesesCount != null,
    hit: (t, p) => t.chatWallets >= p.chatWalletsMin && t.thesesCount >= p.tesisMin,
    body: (t, p) => `Chat ${t.chatWallets} wallets (≥${p.chatWalletsMin}) · ${t.thesesCount} tesis (≥${p.tesisMin}) · MCap $${compact(t.mcap ?? 0)}`,
  },
  track_chat: {
    ready: (t) => t.chatWallets != null,
    hit: (t, p) => t.chatWallets >= p.chatWalletsMin,
    body: (t, p) => `Chat ${t.chatWallets} wallets (≥${p.chatWalletsMin}) · MCap $${compact(t.mcap ?? 0)}`,
  },
  track_tesis: {
    ready: (t) => t.thesesCount != null,
    hit: (t, p) => t.thesesCount >= p.tesisMin,
    body: (t, p) => `${t.thesesCount} tesis (≥${p.tesisMin}) · MCap $${compact(t.mcap ?? 0)}`,
  },
  track_top: {
    ready: (t) => t.topDaily != null,
    hit: (t, p) => t.topDaily >= p.topMin,
    body: (t, p) => `TOP·D ${t.topDaily} (≥${p.topMin}) · MCap $${compact(t.mcap ?? 0)}`,
  },
};

/**
 * Evalúa una categoría de entrada del Track.
 * @returns false cuando el token ya fue evaluado o cuando la fuente todavía no
 * trajo el dato (el llamador reintenta el próximo snapshot — la ventana la fija
 * track.js). El "ya visto" se marca SIEMPRE en la evaluación, haya o no
 * dispositivos suscritos: reactivar la categoría después no re-alerta tokens
 * viejos (misma semántica que los feeds).
 */
export function emitTrackEntry(category, token) {
  const rule = TRACK_RULES[category];
  if (!rule) return false;
  const key = `${category}:${token.address}`;
  if (trackEntrySeen.has(key)) return false;
  if (!rule.ready(token)) return false; // sin dato → NO se marca, se reintenta

  trackEntrySeen.set(key, { at: Date.now() });

  // Keep the seen map bounded.
  const all = trackEntrySeen.getAll();
  const keys = Object.keys(all);
  if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX)) trackEntrySeen.delete(k);

  const devices = Object.values(notificationConfig.getAll()).filter((d) => d?.categories?.[category]);
  for (const device of devices) {
    const params = trackParamsOf(device);
    if (!rule.hit(token, params)) continue; // umbral del dispositivo (chat/tesis/top)
    const entry = notificationHistory.add({
      device_id: device.device_id,
      category,
      address: token.address,
      chain: 'sol',
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      logo: token.logo ?? null,
      mcap: token.mcap ?? null,
      liq: null,
      vol24h: token.volume ?? null,
      holders: token.holders ?? null,
      kolCount: null,
      ageMinutes: null,
      notified_at: new Date().toISOString(),
    });

    // 1. In-app panel: private WS topic, painted by the app wherever it is.
    sendToDevice(device.device_id, { event: 'alert', data: entry });

    // 2. System push: for when the app is not in the foreground.
    if (isValidPushToken(device.push_token)) {
      void sendPush(device.push_token, {
        title: `${token.symbol || token.name || 'Token'} — ${LABELS[category]}`,
        body: rule.body(token, params),
        data: { address: token.address, chain: 'sol', symbol: token.symbol ?? null, category },
      }).catch(() => {});
    }
  }

  trimHistory();
  return true;
}

/** Dirección corta — la misma forma que la app y el panel (5…4). */
const shortAddr = (address) => {
  const a = String(address ?? '');
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;
};

/**
 * Texto del aviso CAL100+ (y de la notificación de Chrome, que lo lee del
 * historial — ver alertBody en el panel): la wallet que entró, cuánto metió y
 * SÓLO las ventanas en verde. Los montos van redondeados hasta $999 (el `toFixed`
 * de compact deja "989.00", que en un aviso se ve sucio).
 */
function cal100Body(token, ev) {
  const money = (n) => (Math.abs(n) >= 1000 ? `$${compact(n)}` : `$${Math.round(n)}`);
  const wins = [];
  if ((ev.pnl1dUsd ?? 0) > 0) wins.push(`1D +${money(ev.pnl1dUsd)}`);
  if ((ev.pnl1wUsd ?? 0) > 0) wins.push(`1W +${money(ev.pnl1wUsd)}`);
  const parts = [shortAddr(ev.address)];
  if (ev.usd != null) parts.push(`metió ${money(ev.usd)}`);
  if (wins.length) parts.push(wins.join(' · '));
  if (token.mcap != null) parts.push(`MCap $${compact(token.mcap)}`);
  return parts.join(' · ');
}

/**
 * Avisa que una entrada CAL100 quedó en verde. La llama sweepCall100 (track.js) en
 * el momento en que el barrido escribe el PnL — el único punto donde se conoce el
 * signo. Sin umbral: el llamador ya decidió que hay verde.
 *
 * `token` es la identidad del token (symbol/name/logo/mcap/volume/holders) y `ev`
 * la fila de la entrada (ver TrackCall100Event en src/lib/track.ts).
 *
 * Una vez por token+wallet: el barrido reescribe una fila con una ventana null
 * hasta CALL100_MAX_TRIES, y esa segunda lectura no debe volver a avisar.
 */
export function emitTrackCal100Pos(token, ev) {
  const key = `${TRACK_CAL100_CATEGORY}:${token.address}:${ev.address}`;
  if (trackEntrySeen.has(key)) return false;
  trackEntrySeen.set(key, { at: Date.now() });

  const all = trackEntrySeen.getAll();
  const keys = Object.keys(all);
  if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX)) trackEntrySeen.delete(k);

  const body = cal100Body(token, ev);
  const devices = Object.values(notificationConfig.getAll()).filter((d) => d?.categories?.[TRACK_CAL100_CATEGORY]);
  for (const device of devices) {
    const entry = notificationHistory.add({
      device_id: device.device_id,
      category: TRACK_CAL100_CATEGORY,
      address: token.address,
      chain: 'sol',
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      logo: token.logo ?? null,
      mcap: token.mcap ?? null,
      liq: null,
      vol24h: token.volume ?? null,
      holders: token.holders ?? null,
      kolCount: null,
      ageMinutes: null,
      // Texto propio: el detalle (wallet, montos, PnL) no entra en los campos
      // fijos del historial. El panel lo prefiere sobre su propio resumen.
      body,
      notified_at: new Date().toISOString(),
    });

    // 1. In-app panel: private WS topic, painted by the app wherever it is.
    sendToDevice(device.device_id, { event: 'alert', data: entry });

    // 2. System push: for when the app is not in the foreground.
    if (isValidPushToken(device.push_token)) {
      void sendPush(device.push_token, {
        title: `${token.symbol || token.name || 'Token'} — ${LABELS[TRACK_CAL100_CATEGORY]}`,
        body,
        data: { address: token.address, chain: 'sol', symbol: token.symbol ?? null, category: TRACK_CAL100_CATEGORY },
      }).catch(() => {});
    }
  }

  trimHistory();
  return true;
}

function trimHistory() {
  const photonish = notificationHistory.filter((e) => e.device_id !== 'seed');
  if (photonish.length > HISTORY_MAX) {
    const ordered = [...notificationHistory.getAll()].sort((a, b) => String(a.notified_at).localeCompare(String(b.notified_at)));
    for (const old of ordered.slice(0, notificationHistory.getAll().length - HISTORY_MAX)) {
      notificationHistory.delete((e) => e.id === old.id);
    }
  }
}
