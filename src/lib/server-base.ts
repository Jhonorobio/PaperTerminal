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

export interface FomoProxyStatus {
  url: string;
  enabled: boolean;
  transport: 'proxy' | 'direct';
}

export interface ServerStatus {
  ok: boolean;
  fomo: { live: boolean; graduated: number; trending: number; proxy: FomoProxyStatus } | null;
  photon: { errorCount: number } | null;
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
    fomo?: { live: boolean; graduated?: { count: number }; trending?: { count: number }; proxy?: FomoProxyStatus };
    photon?: { errorCount?: number };
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
    photon: data.photon ? { errorCount: data.photon.errorCount ?? 0 } : null,
  };
}

export async function getFomoProxy(base: string): Promise<FomoProxyStatus> {
  return call<FomoProxyStatus>(base, '/api/fomo/proxy');
}

/** '' clears the proxy (direct). Throws with the server's validation message. */
export async function setFomoProxy(base: string, url: string): Promise<FomoProxyStatus> {
  return call<FomoProxyStatus>(base, '/api/fomo/proxy', { method: 'PUT', body: JSON.stringify({ url }) });
}

export const proxyHint = 'Acepta http://host:puerto, socks5://host:puerto o host:puerto. Vacío = conexión directa.';

/** The Settings field the base URL is stored under. */
export const SERVER_BASE_KEY: keyof Settings = 'serverBase';
