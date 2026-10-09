/**
 * Notifications client — registers this device with the feed server and keeps
 * the per-category toggles + alert filters in sync.
 *
 * Categories (the server's alert taxonomy):
 *   fomo_graduated · fomo_trending · photon_new · photon_graduated
 *
 * Filters per category accept {min,max} pairs over: usd_market_cap, liquidity,
 * volume_24h, holders_count, kol_count, age_minutes — a token that misses ANY
 * bound is excluded (the server's semantics).
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

const inExpoGo = Constants.executionEnvironment === 'storeClient';

export const ALERT_CATEGORIES = ['fomo_graduated', 'fomo_trending', 'photon_new', 'photon_graduated'] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

/** Fields a category filter can bound. */
export const ALERT_FILTER_FIELDS = ['usd_market_cap', 'liquidity', 'volume_24h', 'holders_count', 'kol_count', 'age_minutes'] as const;
export type AlertFilterField = (typeof ALERT_FILTER_FIELDS)[number];

export interface AlertRange {
  min: number | null;
  max: number | null;
}
export type AlertFilters = Partial<Record<AlertCategory, Partial<Record<AlertFilterField, AlertRange>>>>;

const TIMEOUT_MS = 8_000;

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const deviceId = await getDeviceId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
 * Asks for permission and returns this device's Expo push token. In Expo Go the
 * projectId comes from app.json's extra.eas.projectId; a dev build reads its own.
 */
export async function registerForPush(): Promise<string> {
  const Notifications = await notifications();
  if (!Notifications || inExpoGo) {
    throw new Error(
      inExpoGo
        ? 'Las notificaciones push requieren una development build (Expo Go ya no las soporta desde SDK 53). El panel de alertas en la app sigue funcionando.'
        : 'No se pudo cargar el módulo de notificaciones.',
    );
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
  const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  return token.data;
}

/** True when system push is available here (dev build, not Expo Go). */
export async function pushAvailable(): Promise<boolean> {
  return (await notifications()) != null && !inExpoGo;
}

/**
 * Sets the foreground presentation and wires the "push tapped" deep link. No-op where the
 * module is unavailable (Expo Go), so importing this is always safe.
 */
export async function initPushHandlers(onOpen: (data: { address?: string; symbol?: string | null }) => void): Promise<() => void> {
  const Notifications = await notifications();
  if (!Notifications || inExpoGo) return () => {};
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
  categories?: Record<AlertCategory, boolean>;
  filters?: AlertFilters;
}

/**
 * mcap is typed in thousands on every screen ($K); the server expects USD.
 * Applies the conversion to the filter copy that is sent.
 */
function toServerFilters(filters: AlertFilters): AlertFilters {
  const out: AlertFilters = {};
  for (const [category, fields] of Object.entries(filters ?? {})) {
    const converted: AlertFilters[AlertCategory] = {};
    for (const [field, range] of Object.entries(fields ?? {})) {
      converted[field as AlertFilterField] =
        field === 'usd_market_cap' ? { min: range?.min != null ? range.min * 1000 : null, max: range?.max != null ? range.max * 1000 : null } : { ...range };
    }
    out[category as AlertCategory] = converted;
  }
  return out;
}

/**
 * Registers (or refreshes) this device: push token + which categories alert.
 * When system push is unavailable (Expo Go), the device is registered panel-only:
 * categories and filters still apply, alerts arrive over the private WS topic.
 */
export async function saveCategories(base: string, categories: Record<AlertCategory, boolean>, filters?: AlertFilters): Promise<void> {
  let pushToken: string | null = null;
  try {
    pushToken = await registerForPush();
  } catch {
    pushToken = null;
  }
  await call(base, '/api/notifications/config', {
    method: 'PUT',
    body: JSON.stringify({ push_token: pushToken, categories, filters: filters ? toServerFilters(filters) : undefined }),
  });
}

export async function loadConfig(base: string): Promise<NotificationConfig> {
  try {
    const data = await call<{ registered?: boolean; categories?: Record<string, boolean>; filters?: AlertFilters }>(base, '/api/notifications/config');
    return {
      registered: Boolean(data.registered),
      categories: data.categories as Record<AlertCategory, boolean> | undefined,
      filters: data.filters,
    };
  } catch {
    return { registered: false };
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

/** Fires a synthetic alert through the real path (panel + push). */
export async function sendTestAlert(base: string, category: AlertCategory): Promise<void> {
  await call(base, '/api/notifications/test', { method: 'POST', body: JSON.stringify({ category }) });
}

/** A token tapped from a push (or the floating panel) opens Trade with it selected. */
export function alertDeepLink(entry: { address: string; symbol?: string | null }): string {
  const params = new URLSearchParams({ address: entry.address, ...(entry.symbol ? { symbol: entry.symbol } : {}) }).toString();
  return `/trade?${params}`;
}
