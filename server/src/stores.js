/**
 * Persistent stores — one JSON file each under DATA_DIR.
 *   notification_config: deviceId → { push_token, categories, filters }
 *   notification_history: every alert delivered (the in-app history)
 *   fomo_filters / photon_filters: per-column filter sets
 *   fomo_seen / photon_seen: addresses already processed per category (no repeats)
 */
import { JsonArrayStore, JsonStore } from './json-store.js';

export const notificationConfig = new JsonStore('notification_config');
export const notificationHistory = new JsonArrayStore('notification_history');
export const fomoFilters = new JsonStore('fomo_filters');
export const photonFilters = new JsonStore('photon_filters');
export const fomoSeen = new JsonStore('fomo_seen');
export const photonSeen = new JsonStore('photon_seen');
