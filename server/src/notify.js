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

import { notificationConfig, notificationHistory, fomoSeen, photonSeen, trackBuySeen, trackTopTesisSeen } from './stores.js';
import { getFomoFilters } from './fomo-filter-store.js';
import { isValidPushToken, sendPush } from './push.js';
import { sendToDevice } from './ws.js';

const HISTORY_MAX = 500;
const SEEN_MAX = 5000;

const LABELS = {
  fomo_graduated: 'FOMO Graduados',
  fomo_trending: 'FOMO Trending',
  photon_new: 'Photon New',
  photon_graduated: 'Photon Graduated',
  track_buy: 'Track COMPRAR',
  track_top_tesis: 'Track TOP+TESIS',
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
 * The TRACK buy-signal alert — fired ONCE per address, the minute the tracker's
 * series flips to 'buy' (entry profile + minute-3 momentum). Not a feed token:
 * the signal is computed from the tracked series, so it rides its own seen-map
 * (trackBuySeen) and its own category (`track_buy`), opt-in per device like the
 * rest. Payload mirrors emitToken's so the app paints the same floating panel.
 */
export function emitTrackBuy(token) {
  const key = token.address;
  if (trackBuySeen.has(key)) return false;
  trackBuySeen.set(key, { at: Date.now() });

  // Keep the seen map bounded.
  const all = trackBuySeen.getAll();
  const keys = Object.keys(all);
  if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX)) trackBuySeen.delete(k);

  const devices = Object.values(notificationConfig.getAll()).filter((d) => d?.categories?.track_buy);
  for (const device of devices) {
    const entry = notificationHistory.add({
      device_id: device.device_id,
      category: 'track_buy',
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
        title: `${token.symbol || token.name || 'Token'} — COMPRAR`,
        body: `Señal de compra · MCap $${compact(token.mcap ?? 0)}`,
        data: { address: token.address, chain: 'sol', symbol: token.symbol ?? null, category: 'track_buy' },
      }).catch(() => {});
    }
  }

  trimHistory();
  return true;
}

/**
 * The TRACK "TOP+TESIS" alert — fired ONCE per address, the first minute a
 * tracked token has ≥1 FOMO thesis AND ≥1 pump.fun top trader (D/W/M) at the
 * same time. Validated 16/oct on 51 triggers: 92% rise afterwards, median peak
 * +58% ~10min after the trigger (75% touch +25%, 55% touch +50%) — the play is
 * scalp-into-strength with a stop, never a hold. Same payload shape as
 * emitTrackBuy; `note` marks the best slice (early minute + small mcap).
 */
export function emitTrackTopTesis(token) {
  const key = token.address;
  if (trackTopTesisSeen.has(key)) return false;
  trackTopTesisSeen.set(key, { at: Date.now() });

  // Keep the seen map bounded.
  const all = trackTopTesisSeen.getAll();
  const keys = Object.keys(all);
  if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX)) trackTopTesisSeen.delete(k);

  const devices = Object.values(notificationConfig.getAll()).filter((d) => d?.categories?.track_top_tesis);
  for (const device of devices) {
    const entry = notificationHistory.add({
      device_id: device.device_id,
      category: 'track_top_tesis',
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
        title: `${token.symbol || token.name || 'Token'} — TOP+TESIS`,
        body: `Top + tesis · MCap $${compact(token.mcap ?? 0)}${token.note ? ` · ${token.note}` : ''}`,
        data: { address: token.address, chain: 'sol', symbol: token.symbol ?? null, category: 'track_top_tesis' },
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
