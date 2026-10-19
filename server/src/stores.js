/**
 * Persistent stores — one JSON file each under DATA_DIR.
 *   notification_config: deviceId → { push_token, categories, params }
 *   notification_history: every alert delivered (the in-app history)
 *   fomo_filters / photon_filters: per-column filter sets
 *   fomo_seen / photon_seen: addresses already processed per category (no repeats)
 *   track_entry_seen: tracked addresses already evaluated for the entry alerts
 *   track_config: the tracker's own filter set (independent from the columns')
 *   track_tokens: address → tracked token + its per-minute snapshots (≤50 c/u)
 *     + call100Seen (wallet → minuto en que se vio: línea base del primer
 *       snapshot + dedupe) y call100Events (una fila por wallet con callout
 *       ≥$100 que APARECIÓ después, con su PnL de portfolio 1d/1w al entrar)
 *     + holderSeen / holderEvents (lo mismo para TODOS los holders ≥$100, sin
 *       exigir callout: línea base incluida, PnL una vez y top 50 una vez)
 */
import { JsonArrayStore, JsonStore } from './json-store.js';

export const notificationConfig = new JsonStore('notification_config');
export const notificationHistory = new JsonArrayStore('notification_history');
export const fomoFilters = new JsonStore('fomo_filters');
export const photonFilters = new JsonStore('photon_filters');
export const fomoSeen = new JsonStore('fomo_seen');
export const photonSeen = new JsonStore('photon_seen');
export const trackEntrySeen = new JsonStore('track_entry_seen');
export const trackConfig = new JsonStore('track_config');
export const trackTokens = new JsonStore('track_tokens');
