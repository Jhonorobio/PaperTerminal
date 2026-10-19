/**
 * Paper Terminal — Monitor · shared layer
 *
 * Lo que el service worker y el side panel comparten: la taxonomía de alertas (la
 * MISMA que la app: ids, labels, umbrales y defaults), el storage de settings, los
 * helpers de API/WS y los formateadores.
 *
 * Se carga como ES module desde los dos lados (el worker por "type": "module").
 * Regla de oro: nada de estado en variables globales — el worker puede morir en
 * cualquier momento; todo lo que deba sobrevivir vive en chrome.storage.
 */

/** Server del que cuelga todo (el mismo de la app; en Ajustes se puede cambiar). */
export const DEFAULT_SERVER = 'https://paperterminal-production.up.railway.app';

/** Taxonomía del server — mismas 10 categorías que la pantalla Notificaciones de la app. */
export const ALERT_CATEGORIES = [
  'fomo_trending',
  'fomo_holder_pos',
  'fomo_holder_top',
  'track_cal_chat',
  'track_chat_tesis',
  'track_top',
  'track_cal100_pos',
  'track_holder_pos',
  'track_holder_both',
  'track_holder_top',
];

/**
 * Las del Track (server-side). Las 3 primeras se evalúan en el snapshot de ENTRADA
 * del token. `track_cal100_pos` y las 3 de holder no: avisan cuando el barrido
 * resuelve el PnL de una wallet (y, en holder_top, cuando el match contra el board
 * global da top 50 la primera vez que aparece). Los umbrales de entrada son
 * configurables; CAL100+ y holder pos/both usan además el piso de PnL 1D/1W.
 *
 * Las 2 de FOMO HOLDER no están en esta lista (su id es fomo_*), pero la UI las
 * agrupa con el Track porque sólo miran tokens ACTIVOS del Track.
 */
export const TRACK_CATEGORIES = [
  'track_cal_chat',
  'track_chat_tesis',
  'track_top',
  'track_cal100_pos',
  'track_holder_pos',
  'track_holder_both',
  'track_holder_top',
];

export const CATEGORY_LABELS = {
  fomo_trending: 'FOMO Trending',
  fomo_holder_pos: 'FOMO HOLDER 24H',
  fomo_holder_top: 'FOMO HOLDER TOP50',
  track_cal_chat: 'Track CAL+CHAT',
  track_chat_tesis: 'Track CHAT+TESIS',
  track_top: 'Track TOP·D',
  track_cal100_pos: 'Track CAL100+',
  track_holder_pos: 'Track HOLDER 1D/1W',
  track_holder_both: 'Track HOLDER 1D+1W',
  track_holder_top: 'Track HOLDER TOP50',
};

/** La regla detrás de cada categoría — va como primera línea del cuerpo del aviso. */
export const CATEGORY_HINTS = {
  fomo_trending: 'Trending en FOMO',
  fomo_holder_pos: 'Track activo: holder ≥$100 y PnL 24h sobre el mínimo',
  fomo_holder_top: 'Track activo: holder ≥$100 en clan top 50 (24h/7d)',
  track_cal_chat: 'Entrada: CAL [$100-500) + chat',
  track_chat_tesis: 'Entrada: chat + tesis',
  track_top: 'Entrada: TOP·D',
  track_cal100_pos: 'Entrada CAL100 en verde: 1D o 1W sobre el piso',
  track_holder_pos: 'Holder ≥$100: 1D o 1W sobre el piso',
  track_holder_both: 'Holder ≥$100: 1D y 1W sobre su piso',
  track_holder_top: 'Holder ≥$100 en top 50 daily/weekly',
};

/**
 * Defaults del dispositivo. Espejo de la app: CAL100+ y las 3 de holder del Track
 * nacen ON (con piso de PnL configurable en CAL100+ y holder pos/both); las 3 de
 * entrada del Track y las 2 de holder de FOMO nacen OFF porque son opt-in (miran
 * los holders de los tokens activos del Track y pueden ser ruidosas). FOMO 24H
 * tiene además su propio mínimo de PnL configurable.
 */
export const DEFAULT_CATEGORIES = {
  fomo_trending: false,
  fomo_holder_pos: false,
  fomo_holder_top: false,
  track_cal_chat: false,
  track_chat_tesis: false,
  track_top: false,
  track_cal100_pos: true,
  track_holder_pos: true,
  track_holder_both: true,
  track_holder_top: true,
};

/** Umbrales por dispositivo en el server. PnL en USD (CAL100+, holder pos/both y FOMO 24H). */
export const DEFAULT_ALERT_PARAMS = {
  chatWalletsMin: 2,
  tesisMin: 1,
  topMin: 1,
  pnl1dMinUsd: 500,
  pnl1wMinUsd: 1_000,
  pnl24hMinUsd: 0,
};

/** Rangos útiles — el server los vuelve a sanear del otro lado. */
export function sanitizeAlertParams(raw) {
  const num = (value, fallback, max, min = 1) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : fallback;
  };
  return {
    chatWalletsMin: num(raw?.chatWalletsMin, DEFAULT_ALERT_PARAMS.chatWalletsMin, 50),
    tesisMin: num(raw?.tesisMin, DEFAULT_ALERT_PARAMS.tesisMin, 20),
    topMin: num(raw?.topMin, DEFAULT_ALERT_PARAMS.topMin, 10),
    pnl1dMinUsd: num(raw?.pnl1dMinUsd, DEFAULT_ALERT_PARAMS.pnl1dMinUsd, 1_000_000),
    pnl1wMinUsd: num(raw?.pnl1wMinUsd, DEFAULT_ALERT_PARAMS.pnl1wMinUsd, 1_000_000),
    pnl24hMinUsd: num(raw?.pnl24hMinUsd, DEFAULT_ALERT_PARAMS.pnl24hMinUsd, 1_000_000, 0),
  };
}

/**
 * Topics del server que el panel usa. El server sirve uno más (`fomo_trending`) que
 * el panel no pide: ese tablero se filtra en el teléfono. Sus ALERTAS sí llegan
 * (van por `alerts:{deviceId}`, que arma el worker, no por acá).
 */
export const TOPICS = {
  track: 'track',
};

/** http(s)://host → ws(s)://host/ws */
export function toWsUrl(base) {
  return String(base).replace(/\/+$/, '').replace(/^http/, 'ws') + '/ws';
}

/** Origin (scheme://host) de una URL — lo que piden los permisos opcionales. */
export function originOf(base) {
  try {
    const url = new URL(base);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * GET/PUT/POST contra el server. Las páginas de la extensión tienen su propio origen,
 * así que el CORS del server (allow *) alcanza; igual conviene tener el host en
 * permisos para que Chrome no bloquee la request.
 *
 * El header X-Device-Id va SIEMPRE: los endpoints de notificaciones (config, historial,
 * prueba) lo exigen y sin él el server responde 400. En los feeds/tracker se ignora.
 */
export async function apiCall(base, path, { method = 'GET', body, timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${String(base).replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'X-Device-Id': await getDeviceId(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error ?? `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('El server no responde (timeout).');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Settings persistidos: server, categorías, umbrales y si avisa con notificación del sistema. */
export async function getSettings() {
  const stored = await chrome.storage.local.get({
    serverBase: DEFAULT_SERVER,
    categories: DEFAULT_CATEGORIES,
    params: DEFAULT_ALERT_PARAMS,
    notificationsOn: true,
  });
  return {
    serverBase: String(stored.serverBase || DEFAULT_SERVER).replace(/\/+$/, ''),
    // Merge con los defaults: una categoría nueva del server entra apagada, no ausente.
    categories: { ...DEFAULT_CATEGORIES, ...(stored.categories ?? {}) },
    params: sanitizeAlertParams(stored.params),
    notificationsOn: stored.notificationsOn !== false,
  };
}

export async function setSettings(patch) {
  await chrome.storage.local.set(patch);
  return getSettings();
}

/**
 * Id de este dispositivo (el nombre con el que el server lo conoce). Se genera una vez y
 * vive en storage: es lo que hace que las alertas lleguen al topic `alerts:{id}`.
 */
export async function getDeviceId() {
  const stored = await chrome.storage.local.get('deviceId');
  if (stored.deviceId) return stored.deviceId;
  const id = `ext-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

/** 'feeds' (FOMO/Pump) o 'track' (las del tracker) — agrupa la UI. */
export function categoryGroup(category) {
  // Las 2 de FOMO HOLDER sólo se disparan con tokens activos del Track.
  if (category === 'fomo_holder_pos' || category === 'fomo_holder_top') return 'track';
  return TRACK_CATEGORIES.includes(category) ? 'track' : 'feeds';
}

// ── formateadores (mismos números que la app, sin Intl raro) ──────────────────

export function compactUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(abs < 10 ? 2 : 0);
}

export function signedPct(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function timeAgo(iso) {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at)) return '—';
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86_400)}d`;
}

export function clockOf(iso) {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at)) return '—';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Dirección corta para el panel — misma forma que la app (5…4). */
export function shortAddr(address) {
  const a = String(address ?? '');
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;
}

/** Edad de un token de FOMO: createdAt viene en segundos unix. */
export function ageMinutesOf(createdAt) {
  const secs = Number(createdAt);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return Math.max(0, Math.round((Date.now() / 1000 - secs) / 60));
}

export function formatError(err) {
  return errorText(err);
}
