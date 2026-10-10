/**
 * Client for the feed server (`/server`) — status, health and the FOMO proxy
 * setting. The app talks to it over plain HTTP; live data arrives over the WS
 * (see `./server-feed` when the screens migrate).
 *
 * The base URL lives in Settings (`serverBase`): your PC's LAN address while
 * developing (http://192.168.x.x:8787), the Railway URL in production.
 */

import type { Settings } from './storage';

const TIMEOUT_MS = 8_000;

export interface FeedProxyStatus {
  url: string;
  enabled: boolean;
  transport: 'proxy' | 'direct';
}

export interface ServerStatus {
  ok: boolean;
  fomo: { live: boolean; graduated: number; trending: number; proxy: FeedProxyStatus } | null;
  photon: { errorCount: number; proxy?: FeedProxyStatus } | null;
}

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
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

/** Health + feed status in one shot. Throws with a readable message on failure. */
export async function fetchServerStatus(base: string): Promise<ServerStatus> {
  const data = await call<{
    fomo?: { live: boolean; graduated?: { count: number }; trending?: { count: number }; proxy?: FeedProxyStatus };
    photon?: { errorCount?: number; proxy?: FeedProxyStatus };
  }>(base, '/api/status');
  return {
    ok: true,
    fomo: data.fomo
      ? {
          live: Boolean(data.fomo.live),
          graduated: data.fomo.graduated?.count ?? 0,
          trending: data.fomo.trending?.count ?? 0,
          proxy: data.fomo.proxy ?? { url: '', enabled: false, transport: 'direct' },
        }
      : null,
    photon: data.photon
      ? { errorCount: data.photon.errorCount ?? 0, proxy: data.photon.proxy ?? { url: '', enabled: false, transport: 'direct' } }
      : null,
  };
}

export async function getFeedProxy(base: string): Promise<FeedProxyStatus> {
  return call<FeedProxyStatus>(base, '/api/fomo/proxy');
}

/**
 * Saves the shared FOMO + Photon egress proxy. '' clears the URL (direct); `enabled`
 * flips the switch without losing a saved URL (omit to save-and-activate, which is
 * what a URL alone has always meant). Throws with the server's validation message.
 */
export async function setFeedProxy(base: string, url: string, enabled?: boolean): Promise<FeedProxyStatus> {
  return call<FeedProxyStatus>(base, '/api/fomo/proxy', {
    method: 'PUT',
    body: JSON.stringify(enabled == null ? { url } : { url, enabled }),
  });
}

export const proxyHint =
  'Un solo proxy para FOMO y Photon: http://host:puerto, socks5://host:puerto o host:puerto. El switch lo prende y apaga sin borrar la URL.';

/** The Settings field the base URL is stored under. */
export const SERVER_BASE_KEY: keyof Settings = 'serverBase';

// ── Photon: image proxy + server-side filters ────────────────────────────────

/**
 * Photon's image CDN (tpi.tradewithphoton.com) returns 403 to anything that
 * doesn't carry Photon's Referer — an <Image> in the app can't set it. The server
 * proxies the bytes with the right headers (and caches them).
 */
export function photonLogoUrl(base: string, url: string): string {
  return `${base.replace(/\/+$/, '')}/api/photon/logo?u=${encodeURIComponent(url)}`;
}

/** App filter fields → Photon's query parameter names (the server's FILTER_FIELDS). */
const PHOTON_FIELD_MAP: Record<string, string> = {
  age: 'age',
  mktCap: 'mkt_cap',
  holders: 'holders_count',
  tpHolders: 'tp_holders_count',
  buys: 'buys',
  freshPct: 'fresh_holding_perc',
  bundleHolders: 'bundle_holders_count',
  bundlePct: 'bundle_holding_perc',
};

export type PhotonServerFilters = Record<string, Record<string, { min?: string | number; max?: string | number }>>;

/**
 * Prepares the app's per-column filters for the server: same field names the server
 * already knows (it maps them to Photon's parameters), values stringified.
 */
export function toPhotonServerFilters(filters: PhotonServerFilters): PhotonServerFilters {
  const out: PhotonServerFilters = {};
  for (const [col, fields] of Object.entries(filters)) {
    const clean: Record<string, { min?: string; max?: string }> = {};
    for (const [field, range] of Object.entries(fields ?? {})) {
      if (!PHOTON_FIELD_MAP[field]) continue;
      const pair: { min?: string; max?: string } = {};
      if (range?.min != null && range.min !== '') pair.min = String(range.min);
      if (range?.max != null && range.max !== '') pair.max = String(range.max);
      if (pair.min || pair.max) clean[field] = pair;
    }
    out[col] = clean;
  }
  return out;
}

/**
 * Sends the per-column filters to the server, which re-queries Photon with them:
 * only tokens passing the filter are pushed. Unlike FOMO, Photon is pulled, not
 * streamed — so filtering upstream saves the phone from a list it would discard.
 */
export async function setPhotonServerFilters(base: string, filters: PhotonServerFilters): Promise<void> {
  await call(base, '/api/market/memescope-filters', {
    method: 'PUT',
    body: JSON.stringify(toPhotonServerFilters(filters)),
  });
}
