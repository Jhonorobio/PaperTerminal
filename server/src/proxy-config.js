/**
 * Shared egress proxy for the FOMO feed — one URL, one switch. The Track has its
 * OWN proxy (track_config.proxy, edited on the Track tab), so it never rides this
 * one.
 *
 * It lives in the same `fomo-config` store this endpoint has always used, so an
 * already-configured proxy keeps working unchanged.
 *
 *   url + switch on   → FOMO leaves through the proxy
 *   url + switch off  → URL kept for later, FOMO goes direct (the Settings toggle)
 *   no url            → direct, no matter what the switch says
 *
 * Set from the app: PUT /api/fomo/proxy { url, enabled? }. `enabled` omitted
 * counts as on — the behavior older clients always got.
 */
import { JsonStore } from './json-store.js';

const PROXY_PROTOCOLS = ['http:', 'https:', 'socks:', 'socks4:', 'socks5:'];
const configStore = new JsonStore('fomo-config');

/** '' → '' (direct); a bare `host:port` gets http://; throws on junk. */
export function normalizeProxy(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`proxy inválido: ${v.slice(0, 80)}`);
  }
  if (!PROXY_PROTOCOLS.includes(u.protocol)) {
    throw new Error(`protocolo no soportado: ${u.protocol} (usá http:// o socks5://)`);
  }
  if (!u.hostname) throw new Error('proxy sin host');
  return withScheme;
}

/** The saved URL, switch or no switch; '' = none. */
export function getProxyUrl() {
  const stored = configStore.get('proxy');
  if (stored != null && stored !== '') return normalizeProxy(stored);
  return process.env.FOMO_WS_PROXY ? normalizeProxy(process.env.FOMO_WS_PROXY) : '';
}

/** What consumers actually egress through: saved URL + switch on, else '' (direct). */
export function getEffectiveProxy() {
  try {
    const url = getProxyUrl();
    if (!url) return '';
    return configStore.get('proxy_enabled') === false ? '' : url;
  } catch {
    return '';
  }
}

const changeListeners = new Set();

/** Fires after every save, so each consumer can re-pick its transport. */
export function onProxyChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/** Saves (or clears, with '') the URL and the on/off switch. Returns the status. */
export function setProxy(raw, enabled) {
  const normalized = normalizeProxy(raw); // '' allowed → direct
  configStore.set('proxy', normalized);
  configStore.set('proxy_enabled', enabled != null ? Boolean(enabled) : Boolean(normalized));
  configStore.set('updated_at', new Date().toISOString());
  for (const fn of changeListeners) {
    try {
      fn();
    } catch {
      /* a listener must never break the save */
    }
  }
  return getProxyStatus();
}

export function getProxyStatus() {
  let url = '';
  try {
    url = getProxyUrl();
  } catch {
    url = '';
  }
  return { url, enabled: Boolean(url) && configStore.get('proxy_enabled') !== false };
}
