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
 *   - Track: the server queries Graduated with the Track page's filters, so only
 *     tokens that pass ever enter the tracker (and its alerts).
 * Per-device filters (the old alerts-screen config) are no longer read.
 */

import {
  notificationConfig,
  notificationHistory,
  fomoSeen,
  fomoHolderSeen,
  photonSeen,
  trackEntrySeen,
} from './stores.js';
import { getFomoFilters } from './fomo-filter-store.js';
import { isValidPushToken, sendPush } from './push.js';
import { sendToDevice } from './ws.js';

const HISTORY_MAX = 500;
const SEEN_MAX = 5000;

const LABELS = {
  fomo_trending: 'FOMO Trending',
  fomo_holder_pos: 'FOMO HOLDER 24H',
  fomo_holder_top: 'FOMO HOLDER TOP50',
  // Alertas del Track (ver TRACK_ENTRY_CATEGORIES): se evalúan en la entrada.
  track_cal_chat: 'Track CAL+CHAT',
  track_chat_tesis: 'Track CHAT+TESIS',
  track_top: 'Track TOP',
  track_cal100_pos: 'Track CAL100+',
  // Alertas de holders (ver TRACK_HOLDER_CATEGORIES): una vez por wallet en
  // cada token; el top 50 sale del board global de pump.fun (15 min).
  track_holder_pos: 'Track HOLDER 1D/1W',
  track_holder_both: 'Track HOLDER 1D+1W',
  track_holder_top: 'Track HOLDER TOP50',
};

/**
 * The one FOMO feed that still exists (the app's single tab) against the bounds
 * pushed by the app. A bound on data the token doesn't carry excludes it — the
 * same rule readFeed applies to the visible list.
 */
function passesFeedFilters(token) {
  const feed = getFomoFilters().trending;
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
  // Sólo categorías que existen (ver ALERT_CATEGORIES): un dispositivo con una
  // categoría vieja guardada no puede reencender un feed retirado.
  if (!ALERT_CATEGORIES.includes(category)) return false;
  const store = category.startsWith('fomo') ? fomoSeen : photonSeen;
  const key = `${category}:${token.address}`;
  if (store.has(key)) return false;
  store.set(key, { at: Date.now() });

  // Keep the seen map bounded.
  const all = store.getAll();
  const keys = Object.keys(all);
  if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX)) store.delete(k);

  // FOMO's stream is unfiltered, so the feed's own bounds gate it here (the Track
  // applies its bounds in the column query). The token stays seen either way —
  // loosening a filter later must not re-alert tokens that already passed through.
  if (category.startsWith('fomo') && !passesFeedFilters(token)) return true;

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
 *   track_top        TOP·D ≥N — n=69: 80% sube, 23% x2, +36% pico.
 *
 * Los umbrales (N/M) son POR DISPOSITIVO (`device.params`, editables en la
 * pantalla Notificaciones); los defaults son los medidos.
 */
export const TRACK_ENTRY_CATEGORIES = ['track_cal_chat', 'track_chat_tesis', 'track_top'];

/**
 * TRACK CAL100+ — la entrada CAL100 (fuente 10, ver track.js) cuando el barrido
 * le resuelve el PnL y la deja EN VERDE.
 *
 * No vive en TRACK_ENTRY_CATEGORIES por una razón dura: las de arriba se evalúan
 * en el snapshot de ENTRADA, y acá el dato no está en el snapshot — el PnL lo trae
 * sweepPnl segundos (o un par de minutos) después, 2 requests por wallet y 3
 * en paralelo. ESE es el momento en que se conoce el signo, así que el aviso sale
 * desde el barrido (ver el gancho en track.js).
 *
 * Piso de PnL POR DISPOSITIVO (params pnl1dMinUsd / pnl1wMinUsd, defaults
 * $500 / $1,000): avisa cada wallet que resuelve en verde y además llega al piso
 * en 1D **o** 1W. Sin piso de monto de la entrada (el callout sigue siendo ≥$100).
 *
 * "Verde" = alguna ventana > 0 (1d o 1w), la MISMA regla que pinta la UI (ver
 * WindowPnl en la app y cal100Cell en el panel): la ventana en rojo no cuenta.
 * El "una sola vez" es por token+wallet, no por token: el mismo token avisa por
 * 2, 3, … wallets porque la unidad es la entrada, no el token.
 */
export const TRACK_CAL100_CATEGORY = 'track_cal100_pos';

/**
 * TRACK HOLDER — holders de mint-positions con ≥$100 comprados (sin exigir
 * callout, a diferencia de CAL100+).
 *
 *   track_holder_pos  — la cartera de la wallet está en verde en 1D **o** 1W y
 *                       al menos una de esas ventanas llega a su piso.
 *   track_holder_both — la cartera está en verde en 1D **y** 1W, y **las dos**
 *                       ventanas llegan a su piso configurado (categoría aparte:
 *                       una wallet que cumple avisa por las dos si ambas están ON).
 *   track_holder_top  — al aparecer, la wallet estaba en el top 50 daily **o**
 *                       weekly del board global de pump.fun (ver
 *                       pump-leaderboard.js: refresco cada 15 min, match por
 *                       wallet y userId).
 *
 * El PnL se pide UNA vez por token+wallet (2 requests) y el top 50 se evalúa
 * UNA vez, con el board vigente en ese momento: si la wallet entra al top
 * después, no vuelve a avisar (decisión del usuario). `_pos` y `_both` tienen
 * piso de PnL POR DISPOSITIVO (defaults $500 1D / $1,000 1W); `_top` no.
 * Las tres nacen ON en app y extensión.
 */
export const TRACK_HOLDER_CATEGORIES = ['track_holder_pos', 'track_holder_both', 'track_holder_top'];
/** Corte del aviso TOP de holder: rank ≤ 50 en daily o weekly. */
const HOLDER_TOP_MAX_RANK = 50;

/**
 * FOMO HOLDER — el equivalente de las alertas de holder del Track, pero con los
 * datos de FOMO y SÓLO sobre los tokens que están activos en el Track:
 *
 *   fomo_holder_pos — holder con ≥$100 comprados (costBasis del endpoint
 *                     /hodlers/top) y PnL de 24h positivo (/v2/users) que además
 *                     llega al piso `pnl24hMinUsd` del dispositivo (default 0 =
 *                     cualquier positivo). Sólo 24h: FOMO no expone la ventana
 *                     semanal por usuario.
 *   fomo_holder_top — holder con ≥$100 que pertenece a un clan del top 50 del
 *                     leaderboard de clanes de 24h o 7d, o que aparece entre los
 *                     topMembers de uno de esos clanes.
 *
 * fomo-holders.js recorre `trackTokens` cada 30s y barre los que tienen
 * status === 'active' cada minuto; no escucha el feed de Trending. Una vez por
 * token+categoría, con un resumen de los holders que cumplen (no una alerta por
 * wallet: son cientos por minuto). Nacen OFF en app/extensión: son opt-in y
 * pueden ser ruidosas; se activan en Notificaciones.
 */
export const FOMO_HOLDER_POS_CATEGORY = 'fomo_holder_pos';
export const FOMO_HOLDER_TOP_CATEGORY = 'fomo_holder_top';
export const FOMO_HOLDER_CATEGORIES = [FOMO_HOLDER_POS_CATEGORY, FOMO_HOLDER_TOP_CATEGORY];
/** Mismo corte que el top de Track: rank ≤ 50 en 24h o 7d. */
const FOMO_HOLDER_TOP_MAX_RANK = 50;

/**
 * Las categorías que existen — única fuente de verdad: routes.js guarda exactamente
 * estas y emitToken ignora cualquier otra (una config vieja con una categoría
 * retirada no puede volver a emitirla).
 */
export const ALERT_CATEGORIES = [
  'fomo_trending',
  ...FOMO_HOLDER_CATEGORIES,
  ...TRACK_ENTRY_CATEGORIES,
  TRACK_CAL100_CATEGORY,
  ...TRACK_HOLDER_CATEGORIES,
];

/** Categorías de holder de FOMO activas en al menos un dispositivo. */
export function enabledFomoHolderCategories() {
  const enabled = new Set();
  for (const device of Object.values(notificationConfig.getAll())) {
    for (const category of FOMO_HOLDER_CATEGORIES) {
      if (device?.categories?.[category]) enabled.add(category);
    }
  }
  return enabled;
}

/** Umbrales saneados (defaults medidos, rangos útiles) desde un objeto crudo. */
export function sanitizeTrackParams(raw) {
  const num = (v, def, max, min = 1) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : def;
  };
  return {
    chatWalletsMin: num(raw?.chatWalletsMin, 2, 50),
    tesisMin: num(raw?.tesisMin, 1, 20),
    topMin: num(raw?.topMin, 1, 10),
    // Pisos de PnL (USD) por dispositivo. CAL100+ y holder 1D/1W usan OR;
    // holder 1D+1W exige que las dos ventanas lleguen a su piso.
    pnl1dMinUsd: num(raw?.pnl1dMinUsd, 500, 1_000_000),
    pnl1wMinUsd: num(raw?.pnl1wMinUsd, 1_000, 1_000_000),
    // Piso de PnL 24h de FOMO HOLDER 24H. 0 = cualquier PnL positivo, que es
    // la regla histórica; el usuario puede subirlo desde Notificaciones.
    pnl24hMinUsd: num(raw?.pnl24hMinUsd, 0, 1_000_000, 0),
  };
}

/** Umbrales de un dispositivo, con los defaults medidos y saneados al rango útil. */
export function trackParamsOf(device) {
  return sanitizeTrackParams(device?.params);
}

/**
 * ¿La lectura de PnL de la wallet supera el piso del dispositivo? Es un OR:
 * 1D ≥ piso1D o 1W ≥ piso1W. Se usa en CAL100+ y en holder 1D/1W.
 */
export function pnlFloorHit(ev, params) {
  return (
    (ev?.pnl1dUsd ?? 0) >= params.pnl1dMinUsd ||
    (ev?.pnl1wUsd ?? 0) >= params.pnl1wMinUsd
  );
}

/** `track_holder_both`: las DOS ventanas tienen que llegar a su piso. */
export function pnlBothFloorsHit(ev, params) {
  return (
    (ev?.pnl1dUsd ?? 0) >= params.pnl1dMinUsd &&
    (ev?.pnl1wUsd ?? 0) >= params.pnl1wMinUsd
  );
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
 * Avisa que una entrada CAL100 quedó en verde y llegó al piso de PnL del
 * dispositivo. La llama sweepPnl (track.js) en el momento en que el barrido
 * escribe el PnL — el único punto donde se conoce el signo.
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

  // Piso POR DISPOSITIVO. Si todavía falta una ventana y ningún dispositivo
  // llega al piso, no se marca visto: la lectura parcial se reintenta y puede
  // calificar cuando llegue la otra ventana.
  const devices = Object.values(notificationConfig.getAll())
    .filter((d) => d?.categories?.[TRACK_CAL100_CATEGORY])
    .filter((d) => pnlFloorHit(ev, trackParamsOf(d)));
  const resolved = ev?.pnl1dUsd != null && ev?.pnl1wUsd != null;
  if (!devices.length && !resolved) return false;

  trackEntrySeen.set(key, { at: Date.now() });

  const all = trackEntrySeen.getAll();
  const keys = Object.keys(all);
  if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX)) trackEntrySeen.delete(k);

  const body = cal100Body(token, ev);
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

/**
 * Texto del aviso de holder: wallet (y @usuario si lo hay), lo que metió y el
 * detalle que corresponde a la categoría — las ventanas EN VERDE para
 * pos/both, los puestos ≤50 para top. Mismo formato de montos que CAL100+.
 */
function holderBody(token, ev, category) {
  const money = (n) => (Math.abs(n) >= 1000 ? `$${compact(n)}` : `$${Math.round(n)}`);
  const parts = [ev.userName ? `${shortAddr(ev.address)} @${ev.userName}` : shortAddr(ev.address)];
  if (ev.usd != null) parts.push(`metió ${money(ev.usd)}`);
  if (category === 'track_holder_top') {
    const tops = [];
    if (ev.topDailyRank != null && ev.topDailyRank <= HOLDER_TOP_MAX_RANK) tops.push(`TOP·D #${ev.topDailyRank}`);
    if (ev.topWeeklyRank != null && ev.topWeeklyRank <= HOLDER_TOP_MAX_RANK) tops.push(`TOP·W #${ev.topWeeklyRank}`);
    if (tops.length) parts.push(tops.join(' · '));
  } else {
    const wins = [];
    if ((ev.pnl1dUsd ?? 0) > 0) wins.push(`1D +${money(ev.pnl1dUsd)}`);
    if ((ev.pnl1wUsd ?? 0) > 0) wins.push(`1W +${money(ev.pnl1wUsd)}`);
    if (wins.length) parts.push(wins.join(' · '));
  }
  if (token.mcap != null) parts.push(`MCap $${compact(token.mcap)}`);
  return parts.join(' · ');
}

/**
 * Avisa una de las tres reglas de holder (ver TRACK_HOLDER_CATEGORIES). La llama
 * el tracker: `track_holder_top` en el barrido que evalúa el board una sola vez,
 * y `track_holder_pos` / `track_holder_both` en el momento en que el PnL de la
 * wallet queda resuelto. El guard de abajo evita marcar "visto" si la condición
 * todavía no se cumple (una lectura parcial se reintenta).
 *
 * Una vez por token+wallet+categoría. La unidad es la wallet, no el token: el
 * mismo token puede avisar por 2, 3, … holders.
 */
export function emitTrackHolder(token, ev, category) {
  if (!TRACK_HOLDER_CATEGORIES.includes(category)) return false;
  const pos = (ev?.pnl1dUsd ?? 0) > 0 || (ev?.pnl1wUsd ?? 0) > 0;
  const both = (ev?.pnl1dUsd ?? 0) > 0 && (ev?.pnl1wUsd ?? 0) > 0;
  const top =
    (ev?.topDailyRank != null && ev.topDailyRank <= HOLDER_TOP_MAX_RANK) ||
    (ev?.topWeeklyRank != null && ev.topWeeklyRank <= HOLDER_TOP_MAX_RANK);
  if (category === 'track_holder_pos' && !pos) return false;
  if (category === 'track_holder_both' && !both) return false;
  if (category === 'track_holder_top' && !top) return false;

  // `track_holder_top` no mira PnL. `_pos` usa OR de pisos; `_both` exige los DOS.
  const devices = Object.values(notificationConfig.getAll()).filter((d) => d?.categories?.[category]);
  const targets =
    category === 'track_holder_top'
      ? devices
      : devices.filter((d) =>
          category === 'track_holder_both'
            ? pnlBothFloorsHit(ev, trackParamsOf(d))
            : pnlFloorHit(ev, trackParamsOf(d)),
        );
  const resolved = ev?.pnl1dUsd != null && ev?.pnl1wUsd != null;
  if (category !== 'track_holder_top' && !targets.length && !resolved) return false;

  const key = `${category}:${token.address}:${ev.address}`;
  if (trackEntrySeen.has(key)) return false;
  trackEntrySeen.set(key, { at: Date.now() });

  const all = trackEntrySeen.getAll();
  const keys = Object.keys(all);
  if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX)) trackEntrySeen.delete(k);

  const body = holderBody(token, ev, category);
  for (const device of targets) {
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
      body,
      notified_at: new Date().toISOString(),
    });

    // 1. In-app panel: private WS topic, painted by the app wherever it is.
    sendToDevice(device.device_id, { event: 'alert', data: entry });

    // 2. System push: for when the app is not in the foreground.
    if (isValidPushToken(device.push_token)) {
      void sendPush(device.push_token, {
        title: `${token.symbol || token.name || 'Token'} — ${LABELS[category]}`,
        body,
        data: { address: token.address, chain: 'sol', symbol: token.symbol ?? null, category },
      }).catch(() => {});
    }
  }

  trimHistory();
  return true;
}

/**
 * Texto del aviso de holder de FOMO. Es un resumen POR TOKEN (no una alerta por
 * wallet): FOMO mete decenas de tokens por hora y, al entrar, cada token tiene
 * decenas de holders ≥$100 — avisar uno por uno son cientos de avisos por minuto
 * (medido: 497 en 13 tokens). El body muestra los 3 mejores y el total.
 *
 * Para `fomo_holder_top` el rank es el del CLAN en el leaderboard (el endpoint
 * /v2/clans/leaderboard es de clanes), no un ranking individual.
 */
function fomoHolderBody(token, events, category) {
  const money = (n) => `$${compact(n)}`;
  const who = (ev) => (ev.userName ? `@${ev.userName.replace(/^@/, '')}` : shortAddr(ev.address));
  let list;
  if (category === FOMO_HOLDER_TOP_CATEGORY) {
    list = [...events].sort((a, b) => {
      const rankOf = (ev) => Math.min(ev.top24hRank ?? 999, ev.top7dRank ?? 999);
      return rankOf(a) - rankOf(b);
    });
  } else {
    list = [...events].sort((a, b) => (b.pnl24h ?? 0) - (a.pnl24h ?? 0));
  }

  const parts = [`${list.length} holder${list.length === 1 ? '' : 's'} ≥$100 ${category === FOMO_HOLDER_TOP_CATEGORY ? 'en clanes top' : 'en verde'}`];
  for (const ev of list.slice(0, 3)) {
    const ranks = [];
    if (category === FOMO_HOLDER_TOP_CATEGORY) {
      if (ev.top24hRank != null && ev.top24hRank <= FOMO_HOLDER_TOP_MAX_RANK) {
        ranks.push(`TOP·24H #${ev.top24hRank}${ev.top24hClan ? ` ${ev.top24hClan}` : ''}`);
      }
      if (ev.top7dRank != null && ev.top7dRank <= FOMO_HOLDER_TOP_MAX_RANK) {
        ranks.push(`TOP·7D #${ev.top7dRank}${ev.top7dClan ? ` ${ev.top7dClan}` : ''}`);
      }
      parts.push(`${who(ev)} ${ranks.join(' · ')}`);
    } else {
      parts.push(`${who(ev)} +${money(ev.pnl24h)}`);
    }
  }
  if (list.length > 3) parts.push(`+${list.length - 3} más`);
  if (token.mcap != null) parts.push(`MCap $${compact(token.mcap)}`);
  return parts.join(' · ');
}

/**
 * Avisa una regla de holder de FOMO, UNA vez por token+categoría. La llama
 * fomo-holders.js después de resolver el costBasis, el PnL de 24h y la
 * membresía de clan de todos los holders del token. El guard no marca "visto"
 * si la condición todavía no se cumple (una respuesta parcial se reintenta).
 * Para `fomo_holder_pos`, cada dispositivo recibe el body con los holders que
 * llegan a SU piso `pnl24hMinUsd` (0 = cualquier positivo).
 *
 * @param {object} token identidad del token (address/symbol/name/image/mcap/volume/holders)
 * @param {Array<object>} events [{ address, userName, usd, pnl24h, top24hRank, top24hClan, top7dRank, top7dClan }]
 * @param {'fomo_holder_pos'|'fomo_holder_top'} category
 */
export function emitFomoHolder(token, events, category) {
  if (!FOMO_HOLDER_CATEGORIES.includes(category)) return false;
  const list = Array.isArray(events) ? events : [];
  // Condición base (sin piso): positivo para POS, rank para TOP. El piso 24h
  // se aplica por dispositivo más abajo, así que el body de POS puede cambiar
  // de un dispositivo a otro.
  const qualifying = list.filter((ev) =>
    category === FOMO_HOLDER_TOP_CATEGORY
      ? (ev?.top24hRank != null && ev.top24hRank <= FOMO_HOLDER_TOP_MAX_RANK) ||
        (ev?.top7dRank != null && ev.top7dRank <= FOMO_HOLDER_TOP_MAX_RANK)
      : (ev?.pnl24h ?? 0) > 0,
  );
  if (!qualifying.length) return false;

  const key = `${category}:${token.address}`;
  if (fomoHolderSeen.has(key)) return false;

  const devices = Object.values(notificationConfig.getAll()).filter((d) => d?.categories?.[category]);
  const targets =
    category === FOMO_HOLDER_TOP_CATEGORY
      ? devices.map((device) => ({ device, events: qualifying }))
      : devices
          .map((device) => {
            const min = trackParamsOf(device).pnl24hMinUsd;
            return {
              device,
              events: qualifying.filter((ev) => (ev.pnl24h ?? 0) >= min),
            };
          })
          .filter((target) => target.events.length);

  // Sin ningún dispositivo que alcance el piso, NO se marca visto: el próximo
  // barrido puede encontrar un PnL más alto y recién ahí avisar.
  if (!targets.length) return false;

  fomoHolderSeen.set(key, { at: Date.now() });
  const all = fomoHolderSeen.getAll();
  const keys = Object.keys(all);
  if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX)) fomoHolderSeen.delete(k);

  for (const { device, events: hits } of targets) {
    const body = fomoHolderBody(token, hits, category);
    const entry = notificationHistory.add({
      device_id: device.device_id,
      category,
      address: token.address,
      chain: 'sol',
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      logo: token.image ?? token.logo ?? null,
      mcap: token.mcap ?? null,
      liq: null,
      vol24h: token.volume ?? null,
      holders: token.holders ?? null,
      kolCount: null,
      ageMinutes: null,
      body,
      notified_at: new Date().toISOString(),
    });

    // 1. In-app panel: private WS topic, painted by the app wherever it is.
    sendToDevice(device.device_id, { event: 'alert', data: entry });

    // 2. System push: for when the app is not in the foreground.
    if (isValidPushToken(device.push_token)) {
      void sendPush(device.push_token, {
        title: `${token.symbol || token.name || 'Token'} — ${LABELS[category]}`,
        body,
        data: { address: token.address, chain: 'sol', symbol: token.symbol ?? null, category },
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
