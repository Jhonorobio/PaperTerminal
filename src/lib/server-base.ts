/**
 * Client for the feed server (`/server`) — status, health and the FOMO proxy
 * setting. The app talks to it over plain HTTP; live data arrives over the WS
 * (see `./server-feed` when the screens migrate).
 *
 * The base URL lives in Settings (`serverBase`): your PC's LAN address while
 * developing (http://192.168.x.x:8787), the Railway URL in production.
 */

import type { Settings } from './storage';
import type { FomoFilters } from './types';

const TIMEOUT_MS = 8_000;

export interface FeedProxyStatus {
  url: string;
  enabled: boolean;
  transport: 'proxy' | 'direct';
}

export interface ServerStatus {
  ok: boolean;
  fomo: { live: boolean; trending: number; proxy: FeedProxyStatus } | null;
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
    fomo?: { live: boolean; trending?: { count: number }; proxy?: FeedProxyStatus };
  }>(base, '/api/status');
  return {
    ok: true,
    fomo: data.fomo
      ? {
          live: Boolean(data.fomo.live),
          trending: data.fomo.trending?.count ?? 0,
          proxy: data.fomo.proxy ?? { url: '', enabled: false, transport: 'direct' },
        }
      : null,
  };
}

export async function getFeedProxy(base: string): Promise<FeedProxyStatus> {
  return call<FeedProxyStatus>(base, '/api/fomo/proxy');
}

/**
 * Saves the shared FOMO egress proxy. '' clears the URL (direct); `enabled`
 * flips the switch without losing a saved URL (omit to save-and-activate, which
 * is what a URL alone has always meant). Throws with the server's validation
 * message. The Track has its own proxy, configured on the Track tab.
 */
export async function setFeedProxy(base: string, url: string, enabled?: boolean): Promise<FeedProxyStatus> {
  return call<FeedProxyStatus>(base, '/api/fomo/proxy', {
    method: 'PUT',
    body: JSON.stringify(enabled == null ? { url } : { url, enabled }),
  });
}

/**
 * A restarted server (Railway has no persistent disk) comes back with an empty
 * store — the app keeps the last-saved proxy as a mirror and re-applies it on
 * boot, so FOMO doesn't sit direct (and Cloudflare-blocked) until the user
 * notices. Returns whether it re-applied; the server stays the authority when
 * it has its own copy.
 */
export async function healFeedProxy(base: string, mirrorUrl: string, mirrorOn = true): Promise<boolean> {
  if (!mirrorUrl.trim()) return false;
  const current = await getFeedProxy(base);
  if (current.url) return false;
  await setFeedProxy(base, mirrorUrl.trim(), mirrorOn);
  return true;
}

export const proxyHint =
  'Un solo proxy para FOMO: http://host:puerto, socks5://host:puerto o host:puerto. El switch lo prende y apaga sin borrar la URL.';

/** The Settings field the base URL is stored under. */
export const SERVER_BASE_KEY: keyof Settings = 'serverBase';

// ── FOMO: the screen's filters travel to the server ──────────────────────────

/**
 * Sends the FOMO screen's filters to the server, which uses them for the feed read
 * AND for the alert gate — notifications fire on exactly what the screen shows.
 * Values are the normalized ones the local filter already uses (market cap in
 * dollars: "150" → 150000). Pushed on every change and once per app start, so a
 * restarted server gets them back without anyone touching Settings.
 */
export async function setFomoServerFilters(base: string, filters: { trending: FomoFilters }): Promise<void> {
  await call(base, '/api/fomo/filters', {
    method: 'PUT',
    body: JSON.stringify(filters),
  });
}
