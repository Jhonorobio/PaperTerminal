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
 * Filters are per device per category, with min/max pairs over:
 *   usd_market_cap, liquidity, volume_24h, holders_count, kol_count, age_minutes
 */

import { notificationConfig, notificationHistory, fomoSeen, photonSeen } from './stores.js';
import { isValidPushToken, sendPush } from './push.js';
import { sendToDevice } from './ws.js';

const HISTORY_MAX = 500;
const SEEN_MAX = 5000;

const FILTER_FIELDS = ['usd_market_cap', 'liquidity', 'volume_24h', 'holders_count', 'kol_count', 'age_minutes'];

const LABELS = {
  fomo_graduated: 'FOMO Graduados',
  fomo_trending: 'FOMO Trending',
  photon_new: 'Photon New',
  photon_graduated: 'Photon Graduated',
};

/** Normalizes whatever the device sent into a clean filter map. */
export function sanitizeAlertFilters(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [cat, f] of Object.entries(raw)) {
    if (!LABELS[cat] || !f || typeof f !== 'object') continue;
    const clean = {};
    for (const field of FILTER_FIELDS) {
      const v = f[field];
      if (v && typeof v === 'object') {
        const min = numOrNull(v.min);
        const max = numOrNull(v.max);
        if (min != null || max != null) clean[field] = { min, max };
      }
    }
    if (Object.keys(clean).length) out[cat] = clean;
  }
  return out;
}

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function passesFilters(filters, token) {
  if (!filters) return true;
  const values = {
    usd_market_cap: token.mcap,
    liquidity: token.liquidity,
    volume_24h: token.volume,
    holders_count: token.holders,
    kol_count: token.kolCount,
    age_minutes: token.ageMinutes,
  };
  for (const [field, bound] of Object.entries(filters)) {
    const value = values[field];
    if (value == null) return false; // a bound on data we don't have excludes the token
    if (bound.min != null && value < bound.min) return false;
    if (bound.max != null && value > bound.max) return false;
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

  const devices = Object.values(notificationConfig.getAll()).filter((d) => d?.categories?.[category]);
  for (const device of devices) {
    if (!passesFilters(device.filters?.[category], token)) continue;
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

function trimHistory() {
  const photonish = notificationHistory.filter((e) => e.device_id !== 'seed');
  if (photonish.length > HISTORY_MAX) {
    const ordered = [...notificationHistory.getAll()].sort((a, b) => String(a.notified_at).localeCompare(String(b.notified_at)));
    for (const old of ordered.slice(0, notificationHistory.getAll().length - HISTORY_MAX)) {
      notificationHistory.delete((e) => e.id === old.id);
    }
  }
}
