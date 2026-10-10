/**
 * The FOMO screen's filters, stored once and read by two consumers:
 *   - `fomo.js` — the feed read (WS topic providers / REST fallback);
 *   - `notify.js` — the alert gate, so a notification fires on exactly the list
 *     the phone shows.
 * The app pushes them (PUT /api/fomo/filters) whenever a field changes and once on
 * every start, so the server picks them up even after a restart.
 *
 * Values follow the app's convention: market cap already in dollars (the screen
 * types thousands — "150" → 150000 — and converts before sending), ages in minutes.
 */

import { fomoFilters } from './stores.js';

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export function sanitizeFeedFilters(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const field of ['ageMinMin', 'ageMaxMin', 'mcapMin', 'mcapMax', 'kolMin', 'kolMax']) {
    const v = numOrNull(raw[field]);
    if (v != null) out[field] = v;
  }
  const limit = numOrNull(raw.limit);
  if (limit != null) out.limit = Math.min(Math.max(Math.floor(limit), 1), 1000);
  return out;
}

export function getFomoFilters() {
  const entry = fomoFilters.get('global');
  const root = entry?.filters ?? entry ?? {};
  // Sanitize per feed: the stored shape is { graduated: {...}, trending: {...} },
  // so the field bounds only exist one level deeper than the store entry itself.
  return { graduated: sanitizeFeedFilters(root.graduated), trending: sanitizeFeedFilters(root.trending) };
}

export function setFomoFilters(raw) {
  const clean = {};
  for (const feed of ['graduated', 'trending']) {
    if (raw?.[feed]) clean[feed] = sanitizeFeedFilters(raw[feed]);
  }
  fomoFilters.set('global', { filters: clean, updated_at: new Date().toISOString() });
  return getFomoFilters();
}
