/**
 * Paper Terminal — Monitor · service worker
 *
 * Su único trabajo es el de la app cuando está en background: mantener el WebSocket
 * del server suscrito al topic `alerts:{deviceId}` y convertir cada alerta en una
 * notificación de Chrome. Los tableros (FOMO/Photon/Track/Pump) los pinta el side
 * panel con su propia conexión — acá solo viajan las alertas.
 *
 * Sobre la vida del worker (Chrome 116+): mandar/recibir sobre un WebSocket resetea el
 * timer de inactividad, así que el ping de 20 s lo mantiene despierto mientras hay
 * socket. Igual todo se asume mortal: hay un alarm por minuto que lo revive y
 * `pollHistory()` como red de seguridad para las alertas que llegaron mientras dormía.
 */

import {
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  DEFAULT_CATEGORIES,
  apiCall,
  compactUsd,
  formatError,
  getDeviceId,
  getSettings,
  sanitizeAlertParams,
  setSettings,
  toWsUrl,
} from './shared.js';

const PING_MS = 20_000;
const RECONNECT_MS = 5_000;
/** Ids de alertas ya avisadas (dedupe del WS + del fallback de historial). */
const SEEN_MAX = 200;
const ALARM_WATCHDOG = 'pt-watchdog';
const ALARM_HISTORY = 'pt-history';

let socket = null;
let pingTimer = null;
let reconnectTimer = null;
let settingsCache = null;

async function settings() {
  if (!settingsCache) settingsCache = await getSettings();
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.categories || changes.params || changes.serverBase)) settingsCache = null;
});

// ── registro del dispositivo + config ─────────────────────────────────────────

/**
 * Manda las categorías y umbrales al server. Sin esto el server no sabe que este
 * dispositivo existe y no emite nada hacia `alerts:{id}`; el push token va en null
 * porque una extensión no puede tener uno de Expo (el aviso lo pinta Chrome).
 */
async function syncConfig() {
  const s = await settings();
  const categories = { ...DEFAULT_CATEGORIES, ...s.categories };
  const params = sanitizeAlertParams(s.params);
  await setSettings({ categories, params });
  try {
    await apiCall(s.serverBase, '/api/notifications/config', {
      method: 'PUT',
      body: { push_token: null, categories, params },
    });
    await chrome.storage.local.set({ syncError: null });
    return { ok: true };
  } catch (err) {
    const message = formatError(err);
    // El panel lo muestra en Ajustes: sin registro no llega ninguna alerta.
    await chrome.storage.local.set({ syncError: message });
    return { ok: false, error: message };
  }
}

// ── WebSocket de alertas ──────────────────────────────────────────────────────

function clearTimers() {
  if (pingTimer) clearInterval(pingTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  pingTimer = null;
  reconnectTimer = null;
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      /* se cae en onclose */
    }
  }
}

function disconnect() {
  clearTimers();
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ya estaba */
    }
    socket = null;
  }
}

async function connect() {
  const s = await settings();
  const deviceId = await getDeviceId();
  disconnect();

  let next;
  try {
    next = new WebSocket(toWsUrl(s.serverBase));
  } catch {
    scheduleReconnect();
    return;
  }
  socket = next;

  next.onopen = () => {
    send({ action: 'subscribe', topic: `alerts:${deviceId}` });
    // El ping hace dos cosas: le dice al server que seguimos vivos y resetea el
    // timer de inactividad del worker.
    pingTimer = setInterval(() => send({ action: 'ping' }), PING_MS);
    void chrome.storage.local.set({ wsConnectedAt: Date.now() });
    broadcastStatus();
  };

  next.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (msg.topic?.startsWith('alerts:')) void handleAlert(msg.data);
  };

  next.onclose = () => {
    if (socket === next) socket = null;
    clearTimers();
    void chrome.storage.local.set({ wsConnectedAt: 0 });
    broadcastStatus();
    scheduleReconnect();
  };

  next.onerror = () => {
    /* onclose se encarga */
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, RECONNECT_MS);
}

/** Avisa a los paneles abiertos (si no hay ninguno, el error se ignora). */
function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'status', connected: Boolean(socket && socket.readyState === WebSocket.OPEN) }).catch(() => {});
}

// ── alertas ───────────────────────────────────────────────────────────────────

/**
 * Una alerta llegó (por WS o por el fallback de historial). Dedupe por id, avisa con
 * la notificación del sistema y se la pasa a los paneles abiertos.
 */
async function handleAlert(raw) {
  const entry = normalizeEntry(raw);
  if (!entry) return;

  const { seenAlertIds = [] } = await chrome.storage.local.get('seenAlertIds');
  if (seenAlertIds.includes(entry.id)) return;

  const index = (await chrome.storage.local.get('alertIndex')).alertIndex ?? {};
  index[`pt-${entry.id}`] = { address: entry.address, symbol: entry.symbol ?? null };
  const indexKeys = Object.keys(index);
  for (const key of indexKeys.slice(0, Math.max(0, indexKeys.length - SEEN_MAX))) delete index[key];

  await chrome.storage.local.set({
    seenAlertIds: [entry.id, ...seenAlertIds].slice(0, SEEN_MAX),
    alertIndex: index,
    lastAlertAt: Date.now(),
  });

  const s = await settings();
  if (s.notificationsOn) showNotification(entry);
  chrome.runtime.sendMessage({ type: 'alert', entry }).catch(() => {});
}

/** El frame del WS trae el entry del historial; el GET de historial trae lo mismo. */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const address = typeof raw.address === 'string' ? raw.address : null;
  if (!address) return null;
  return {
    // El server numera el historial (JsonArrayStore): ese id es el dedupe.
    id: raw.id ?? `${raw.category}:${address}:${raw.notified_at ?? ''}`,
    // Sin catálogo de categorías hardcodeado: el server es la fuente y el label cae al id.
    category: typeof raw.category === 'string' ? raw.category : 'fomo_graduated',
    address,
    symbol: raw.symbol ?? null,
    name: raw.name ?? null,
    mcap: numOrNull(raw.mcap),
    vol24h: numOrNull(raw.vol24h),
    holders: numOrNull(raw.holders),
    notified_at: raw.notified_at ?? new Date().toISOString(),
  };
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Cuerpo del aviso: la regla que disparó + los números del token. */
function alertBody(entry) {
  const bits = [];
  if (entry.mcap) bits.push(`MCap $${compactUsd(entry.mcap)}`);
  if (entry.vol24h) bits.push(`Vol $${compactUsd(entry.vol24h)}`);
  if (entry.holders) bits.push(`${entry.holders} holders`);
  return [CATEGORY_HINTS[entry.category] ?? null, bits.join(' · ') || null].filter(Boolean).join(' — ') || 'Alerta del server';
}

function showNotification(entry) {
  const label = CATEGORY_LABELS[entry.category] ?? entry.category;
  const symbol = entry.symbol || entry.name || 'Token';
  chrome.notifications.create(
    `pt-${entry.id}`,
    {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `${symbol} — ${label}`,
      message: alertBody(entry),
      priority: 2,
      silent: false,
    },
    () => void chrome.runtime.lastError,
  );
}

/**
 * Red de seguridad: si el worker estaba muerto cuando llegó el frame, el historial del
 * server (por dispositivo, que es solo el nuestro) la tiene. Reusa el dedupe.
 */
async function pollHistory() {
  const s = await settings();
  try {
    const data = await apiCall(s.serverBase, '/api/notifications/history?limit=20');
    for (const item of data.items ?? []) await handleAlert(item);
  } catch {
    /* server caído: el próximo alarm reintenta */
  }
}

// ── arranque ──────────────────────────────────────────────────────────────────

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  try {
    await getDeviceId();
    await settings();
    await syncConfig();
    await connect();
    // El worker duerme; estos son los latidos que lo despiertan.
    await chrome.alarms.create(ALARM_WATCHDOG, { periodInMinutes: 1 });
    await chrome.alarms.create(ALARM_HISTORY, { periodInMinutes: 1 });
    // Un click en el ícono abre el panel lateral (Chrome 120+).
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    // Primera pasada: avisa de lo que haya en el historial desde la última vez.
    await pollHistory();
  } finally {
    booted = false;
  }
}

chrome.runtime.onInstalled.addListener(() => void boot());
chrome.runtime.onStartup.addListener(() => void boot());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_WATCHDOG) {
    if (!socket || socket.readyState !== WebSocket.OPEN) void connect();
  } else if (alarm.name === ALARM_HISTORY) {
    void pollHistory();
  }
});

// ── mensajes del panel ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const s = await settings();
    switch (message?.type) {
      case 'get-state': {
        const deviceId = await getDeviceId();
        const { syncError = null } = await chrome.storage.local.get('syncError');
        sendResponse({
          deviceId,
          serverBase: s.serverBase,
          connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
          syncError,
        });
        return;
      }
      case 'save-config': {
        settingsCache = null;
        await setSettings({
          serverBase: message.serverBase ?? s.serverBase,
          categories: { ...s.categories, ...(message.categories ?? {}) },
          params: sanitizeAlertParams(message.params ?? s.params),
        });
        const sync = await syncConfig();
        await connect();
        sendResponse({ ...sync, connected: Boolean(socket && socket.readyState === WebSocket.OPEN) });
        return;
      }
      case 'test-alert': {
        try {
          const result = await apiCall(s.serverBase, '/api/notifications/test', {
            method: 'POST',
            body: { category: message.category ?? 'pump_trending' },
            timeoutMs: 20_000,
          });
          sendResponse({ ok: true, push: result.push ?? null });
        } catch (err) {
          sendResponse({ ok: false, error: formatError(err) });
        }
        return;
      }
      case 'reconnect': {
        await connect();
        sendResponse({ ok: true, connected: Boolean(socket && socket.readyState === WebSocket.OPEN) });
        return;
      }
      case 'status': {
        sendResponse({ connected: Boolean(socket && socket.readyState === WebSocket.OPEN), deviceId: await getDeviceId() });
        return;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // respuesta asíncrona
});

// ── click en la notificación → panel lateral en el token (o GMGN de fallback) ──

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const { alertIndex = {} } = await chrome.storage.local.get('alertIndex');
  const target = alertIndex[notificationId] ?? null;
  chrome.notifications.clear(notificationId);
  if (!target?.address) return;

  const gmgn = `https://gmgn.ai/sol/token/${target.address}`;
  try {
    const win = await chrome.windows.getLastFocused();
    if (win?.id != null) {
      await chrome.sidePanel.open({ windowId: win.id });
      chrome.runtime.sendMessage({ type: 'focus-address', address: target.address, symbol: target.symbol }).catch(() => {});
      return;
    }
  } catch {
    /* sin gesto de usuario: cae al tab */
  }
  chrome.tabs.create({ url: gmgn });
});

// La primera vuelta de la vida del worker: booteá aunque el evento no haya llegado.
void boot();
