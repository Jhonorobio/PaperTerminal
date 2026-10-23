/**
 * Notifications client — registers this device with the feed server and keeps the
 * per-category toggles in sync.
 *
 * Categories (the server's alert taxonomy):
 *   fomo_trending · fomo_holder_pos · fomo_holder_top
 *   track_cal_chat · track_chat_tesis · track_top
 *   track_cal100_pos
 *   track_holder_pos · track_holder_both · track_holder_top
 *   track_fib
 *
 * fomo_holder_pos/_top son el equivalente FOMO de las alertas de holder del
 * Track, pero SÓLO se evalúan sobre tokens activos en Track (no sobre el feed
 * de Trending; ver fomo-holders.js), con holders de ≥$100 comprados. Se revisan
 * cada minuto mientras el token siga activo. `_pos` = PnL de 24h positivo que
 * además llega al piso `pnl24hMinUsd` del dispositivo (FOMO sólo expone 24h por
 * usuario); `_top` = el clan del holder está en el top 50 de 24h o 7d (o el
 * holder aparece en los topMembers de ese clan). Avisan UNA vez por token+categoría
 * con un resumen de hasta 3 holders: una alerta por wallet serían cientos por minuto.
 *
 * The three track_* entry alerts fire at the token's ENTRY snapshot (see
 * TRACK_RULES in server/src/notify.js) and the chat/tesis/top thresholds are per
 * device (AlertParams, edited on the Notifications screen).
 *
 * track_cal100_pos is the exception: it is NOT evaluated at a snapshot — it fires
 * when the CAL100 sweep resolves a wallet's portfolio PnL and finds it green in
 * 1d or 1w (TRACK_CAL100_CATEGORY in server/src/notify.js). It also needs the
 * device's PnL floor: 1D ≥ pnl1dMinUsd OR 1W ≥ pnl1wMinUsd. Its unit is the
 * entry, not the token: the same token can alert for 2, 3, … wallets.
 *
 * The track_holder_* alerts are also per wallet, but for EVERY holder ≥$100 of
 * mint-positions (callout not required): `_pos` = 1d or 1w positive with at least
 * one floor, `_both` = both positive AND both floors, `_top` = the wallet was in
 * the global top 50 daily/weekly when first seen. `_top` does not use PnL floors.
 * One alert per token+wallet and category.
 *
 * `track_fib` is the Fibonacci watcher: only tokens visible in Track's Graduated
 * section, base = launch low and ATH fixed when tracking starts, and ONE alert
 * per level touched (0.236, 0.382, 0.5, 0.618, 0.786, 1.0). It is not tied to
 * snapshots; the server polls 30S candles from Azura (see server/src/fib.js).
 *
 * There is no filter configuration here anymore: the feed screens own the filters
 * (FOMO pins its tab, the Track page owns its Graduated set) and the server gates
 * the alerts with those — what fires is exactly what the phone shows.
 */

import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { getDeviceId } from './device-id';

/**
 * expo-notifications is loaded lazily and defensively: since SDK 53, importing it inside
 * Expo Go on Android throws at module load ("remote notifications removed from Expo Go"),
 * which would take the whole app down. The in-app alert panel does not need it — it rides
 * the server's WebSocket — so only the *system push* path pays for this import, and it
 * fails with a readable message instead of a crash.
 */
let notificationsModule: typeof import('expo-notifications') | null = null;
let notificationsChecked = false;

async function notifications() {
  if (notificationsChecked) return notificationsModule;
  notificationsChecked = true;
  try {
    notificationsModule = await import('expo-notifications');
  } catch {
    notificationsModule = null;
  }
  return notificationsModule;
}

/**
 * Development builds ALSO report executionEnvironment 'storeClient' while Metro serves
 * their JS, so that flag can't gate push: the lazy import above is the real test (Expo Go
 * Android throws at import — "remote notifications removed from Expo Go").
 */

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
  'track_fib',
] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

/**
 * Defaults per category — la fuente de verdad de la app (la extensión la espeja
 * en extension/shared.js). CAL100+, las 3 de holder del Track y FIB nacen ON;
 * las 3 de entrada del Track y las 2 de holder de FOMO nacen OFF porque son
 * opt-in (miran los holders de los tokens activos del Track y pueden ser ruidosas).
 *
 * `registerDevice` los mezcla al abrir la app: una categoría nueva que este
 * dispositivo todavía no guardó entra con su default (y se sincroniza al server),
 * sin tocar los `false` explícitos que el usuario ya eligió.
 */
export const DEFAULT_CATEGORIES: Record<AlertCategory, boolean> = {
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
  track_fib: true,
};

/**
 * Track entry alerts fire at the token's ENTRY snapshot (minute 0). Chat, thesis,
 * top and the PnL 1D/1W floors are per device; the defaults are the measured ones
 * (see TRACK_RULES and sanitizeTrackParams in server/src/notify.js).
 */
export interface AlertParams {
  chatWalletsMin: number;
  tesisMin: number;
  topMin: number;
  /** Piso de PnL (USD) de CAL100+ y holder 1D/1W: 1D ≥ este valor. */
  pnl1dMinUsd: number;
  /** Piso de PnL (USD) de CAL100+ y holder 1D/1W: 1W ≥ este valor. */
  pnl1wMinUsd: number;
  /** Piso de PnL (USD) de FOMO HOLDER 24H. 0 = cualquier PnL positivo. */
  pnl24hMinUsd: number;
}

export const DEFAULT_ALERT_PARAMS: AlertParams = {
  chatWalletsMin: 2,
  tesisMin: 1,
  topMin: 1,
  pnl1dMinUsd: 500,
  pnl1wMinUsd: 1_000,
  pnl24hMinUsd: 0,
};

/** Clamps raw values to the useful ranges the server also enforces. */
export function sanitizeAlertParams(raw?: Partial<AlertParams> | null): AlertParams {
  const num = (v: unknown, def: number, max: number, min = 1) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : def;
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

const TIMEOUT_MS = 8_000;

async function call<T>(base: string, path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<T> {
  const deviceId = await getDeviceId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId,
        ...(init?.body ? {} : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('El server no responde (timeout).');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks for permission and returns this device's Expo push token. Needs expo-notifications
 * (a development build) — Expo Go's module throws at import and lands in the readable error.
 */
export async function registerForPush(): Promise<string> {
  const Notifications = await notifications();
  if (!Notifications) {
    throw new Error('No se pudo cargar el módulo de notificaciones (¿Expo Go?). Requiere una development build.');
  }

  const settings = await Notifications.getPermissionsAsync();
  let granted = settings.granted;
  if (!granted) {
    const ask = await Notifications.requestPermissionsAsync();
    granted = ask.granted;
  }
  if (!granted) throw new Error('Permiso de notificaciones denegado.');

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('alerts', {
      name: 'Alertas de tokens',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: '#a896ff',
    }).catch(() => {});
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  try {
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return token.data;
  } catch (err) {
    throw new Error(
      `No se pudo obtener el token de push (${err instanceof Error ? err.message : String(err)}). Requiere una development build instalada.`,
    );
  }
}

/** True when the push module is available (dev build). Expo Go's import throws → null. */
export async function pushAvailable(): Promise<boolean> {
  return (await notifications()) != null;
}

/**
 * Sets the foreground presentation and wires the "push tapped" deep link. No-op where the
 * module is unavailable (Expo Go), so importing this is always safe.
 */
export async function initPushHandlers(onOpen: (data: { address?: string; symbol?: string | null }) => void): Promise<() => void> {
  const Notifications = await notifications();
  if (!Notifications) return () => {};
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = (response.notification.request.content.data ?? {}) as { address?: string; symbol?: string | null };
    if (data.address) onOpen(data);
  });
  return () => sub.remove();
}

export interface NotificationConfig {
  registered: boolean;
  hasPush?: boolean;
  categories?: Record<AlertCategory, boolean>;
  params?: AlertParams;
}

/**
 * Registers (or refreshes) this device: push token + which categories alert.
 * When system push is unavailable (Expo Go), the device is registered panel-only:
 * categories still apply, alerts arrive over the private WS topic.
 * @returns the push registration error, or null when the token was obtained.
 */
export async function saveCategories(
  base: string,
  categories: Record<AlertCategory, boolean>,
  params?: AlertParams,
): Promise<string | null> {
  let pushToken: string | null = null;
  let pushError: string | null = null;
  try {
    pushToken = await registerForPush();
  } catch (err) {
    pushToken = null;
    pushError = err instanceof Error ? err.message : String(err);
  }
  await call(base, '/api/notifications/config', {
    method: 'PUT',
    body: JSON.stringify({ push_token: pushToken, categories, params: sanitizeAlertParams(params) }),
  });
  return pushError;
}

export async function loadConfig(base: string): Promise<NotificationConfig> {
  try {
    const data = await call<{ registered?: boolean; has_push?: boolean; categories?: Record<string, boolean>; params?: Partial<AlertParams> }>(base, '/api/notifications/config');
    return {
      registered: Boolean(data.registered),
      hasPush: Boolean(data.has_push),
      categories: data.categories as Record<AlertCategory, boolean> | undefined,
      params: sanitizeAlertParams(data.params),
    };
  } catch {
    return { registered: false };
  }
}

/**
 * Re-registers this device's push token on app open, keeping the saved categories and
 * thresholds — tokens rotate, so the server's copy must be refreshed without anyone
 * touching the alerts screen. Skips when this device never saved categories (nothing
 * to alert about yet).
 * @returns why registration left the server without a token, or null when ok.
 */
export async function registerDevice(base: string): Promise<string | null> {
  if (!base) return null;
  try {
    const cfg = await loadConfig(base);
    if (!cfg.categories) return null;
    // Una categoría nueva (agregada después del último sync de este dispositivo)
    // entra con su default —CAL100+ y las de holder, ON— para que el server la
    // emita sin esperar a que alguien abra Notificaciones. Un `false` guardado se
    // respeta: el spread de cfg.categories pisa el default.
    return await saveCategories(base, { ...DEFAULT_CATEGORIES, ...cfg.categories }, cfg.params);
  } catch (err) {
    // Server unreachable or the PUT was rejected (e.g. token format) — report it.
    return err instanceof Error ? err.message : String(err);
  }
}

export interface AlertHistoryEntry {
  id: number;
  category: string;
  address: string;
  chain?: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  mcap: number | null;
  liq: number | null;
  vol24h: number | null;
  holders: number | null;
  kolCount: number | null;
  ageMinutes: number | null;
  /**
   * Texto armado por el server cuando el detalle no entra en los campos fijos
   * (CAL100+ y las alertas de holder: wallets, montos, ventanas/ranks; en FOMO
   * es un resumen por token con los 3 mejores). El panel flotante y la timeline
   * lo prefieren sobre su propio resumen.
   */
  body?: string | null;
  notified_at: string;
}

export async function fetchHistory(base: string, limit = 100): Promise<AlertHistoryEntry[]> {
  try {
    const data = await call<{ items?: AlertHistoryEntry[] }>(base, `/api/notifications/history?limit=${limit}`);
    return data.items ?? [];
  } catch {
    return [];
  }
}

export interface TestPushResult {
  sent: boolean;
  reason?: string;
  ticket?: { status?: string; details?: { error?: string; message?: string } } | null;
  receipt?: { status?: string; details?: { error?: string; message?: string } } | null;
}

/**
 * Fires a synthetic alert through the real path (panel + push) and reports what Expo
 * answered — ticket + FCM delivery receipt — so "no me llegó" is diagnosable from the
 * app instead of guessed at. Server wait (receipt poll) needs a longer timeout.
 */
export async function sendTestAlert(base: string, category: AlertCategory): Promise<TestPushResult | null> {
  const data = await call<{ push?: TestPushResult }>(base, '/api/notifications/test', {
    method: 'POST',
    body: JSON.stringify({ category }),
  }, 20_000);
  return data.push ?? null;
}

/** A token tapped from a push (or the floating panel) opens Trade with it selected. */
export function alertDeepLink(entry: { address: string; symbol?: string | null }): string {
  const params = new URLSearchParams({ address: entry.address, ...(entry.symbol ? { symbol: entry.symbol } : {}) }).toString();
  return `/trade?${params}`;
}
