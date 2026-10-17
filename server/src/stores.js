/**
 * Persistent stores — one JSON file each under DATA_DIR.
 *   notification_config: deviceId → { push_token, categories, filters }
 *   notification_history: every alert delivered (the in-app history)
 *   fomo_filters / photon_filters: per-column filter sets
 *   fomo_seen / photon_seen: addresses already processed per category (no repeats)
 *   track_config: the tracker's own filter set (independent from the columns')
 *   track_tokens: address → tracked token + its per-minute snapshots (≤50 c/u)
 */
import { JsonArrayStore, JsonStore } from './json-store.js';

export const notificationConfig = new JsonStore('notification_config');
export const notificationHistory = new JsonArrayStore('notification_history');
export const fomoFilters = new JsonStore('fomo_filters');
export const photonFilters = new JsonStore('photon_filters');
export const fomoSeen = new JsonStore('fomo_seen');
export const photonSeen = new JsonStore('photon_seen');
export const trackBuySeen = new JsonStore('track_buy_seen');
export const trackAtencionSeen = new JsonStore('track_atencion_m1_seen');
export const trackTopTesisSeen = new JsonStore('track_top_tesis_seen');
export const trackConfig = new JsonStore('track_config');
export const trackTokens = new JsonStore('track_tokens');
