// Port of the extension's positions.js logo cache. The paper server hands back token logos as
// data: URLs (the FOMO page's CSP blocks image CDNs); React Native just needs them cached so a
// scrolling list does not refetch the same logo on every render.

import { api } from './api';

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

const keyOf = (chainId?: string | null, address?: string | null) => (chainId && address ? `${chainId}:${address}` : '');

/** Token logo as a data: URL, or null when the server has none. */
export function tokenLogo(chainId?: string | null, address?: string | null): Promise<string | null> {
  const key = keyOf(chainId, address);
  if (!key) return Promise.resolve(null);
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const existing = pending.get(key);
  if (existing) return existing;

  const request = api
    .tokenLogo(chainId as string, address as string)
    .then((r) => r.dataUrl || null, () => null)
    .then((dataUrl) => {
      cache.set(key, dataUrl);
      pending.delete(key);
      return dataUrl;
    });
  pending.set(key, request);
  return request;
}

/** Synchronous read for a render; returns undefined while still loading. */
export function peekLogo(chainId?: string | null, address?: string | null): string | null | undefined {
  const key = keyOf(chainId, address);
  return key ? cache.get(key) : null;
}
