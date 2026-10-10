/**
 * Notifications client — registers this device with the feed server and keeps the
 * per-category toggles in sync.
 *
 * Categories (the server's alert taxonomy):
 *   fomo_graduated · fomo_trending · photon_new · photon_graduated
 *
 * There is no filter configuration here anymore: the feed screens own the filters
 * (FOMO pushes both tabs, Photon pushes its columns) and the server gates the
 * alerts with those — what fires is exactly what the phone shows.
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

export const ALERT_CATEGORIES = ['fomo_graduated', 'fomo_trending', 'photon_new', 'photon_graduated'] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

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
}

/**
 * Registers (or refreshes) this device: push token + which categories alert.
 * When system push is unavailable (Expo Go), the device is registered panel-only:
 * categories still apply, alerts arrive over the private WS topic.
 */
export async function saveCategories(base: string, categories: Record<AlertCategory, boolean>): Promise<void> {
  let pushToken: string | null = null;
  try {
    pushToken = await registerForPush();
  } catch {
    pushToken = null;
  }
  await call(base, '/api/notifications/config', {
    method: 'PUT',
    body: JSON.stringify({ push_token: pushToken, categories }),
  });
}

export async function loadConfig(base: string): Promise<NotificationConfig> {
  try {
    const data = await call<{ registered?: boolean; has_push?: boolean; categories?: Record<string, boolean> }>(base, '/api/notifications/config');
    return {
      registered: Boolean(data.registered),
      hasPush: Boolean(data.has_push),
      categories: data.categories as Record<AlertCategory, boolean> | undefined,
    };
  } catch {
    return { registered: false };
  }
}

/**
 * Re-registers this device's push token on app open, keeping the saved categories —
 * tokens rotate, so the server's copy must be refreshed without anyone touching the
 * alerts screen. Skips when the server doesn't answer (its state stays untouched) or
 * when this device never saved categories (nothing to alert about yet).
 */
export async function registerDevice(base: string): Promise<void> {
  if (!base) return;
  try {
    const cfg = await loadConfig(base);
    if (!cfg.categories) return;
    await saveCategories(base, cfg.categories);
  } catch {
    /* panel-only is fine; the next app open retries */
  }
}

export interface AlertHistoryEntry {
  id: number;
  category: string;
  address: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  mcap: number | null;
  liq: number | null;
  vol24h: number | null;
  holders: number | null;
  kolCount: number | null;
  ageMinutes: number | null;
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
