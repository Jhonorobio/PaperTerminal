/**
 * Trenchers Pulse — keyless per-token enrichment: KOL count and creation time.
 * Ported from `server con APIS/src/services/pulse-kol.js` + `token-age.js`.
 *
 * FOMO's own payloads lack both fields: graduated tokens carry `createdAt` but
 * never a KOL count, and trending tokens carry neither. When a filter asks for
 * them, the visible candidates are resolved here and the values stick to the
 * records (the feed merge preserves them).
 *
 * The endpoint is a plain GET with no API key, so the phone can call it directly:
 *   GET https://pulse-production.trenchers.ai/pulse/token/{address}
 *   → { kol_count?: number, created_at?: string }
 */

import type { FomoToken } from '../types';

const PULSE_URL = 'https://pulse-production.trenchers.ai/pulse/token';
const FETCH_TIMEOUT_MS = 15_000;
/** Solid counts move slowly — a long TTL keeps the phone from hammering them. */
const KOL_TTL_MS = 5 * 60_000;
const AGE_TTL_MS = 15 * 60_000;
const NULL_TTL_MS = 60_000;
const CONCURRENCY = 25;

interface Entry {
  kolCount: number | null;
  createdAt: number | null;
  at: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<{ kolCount: number | null; createdAt: number | null }>>();

async function fetchPulse(address: string): Promise<{ kolCount: number | null; createdAt: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${PULSE_URL}/${encodeURIComponent(address)}`, {
      headers: { accept: '*/*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { kol_count?: unknown; created_at?: unknown };
    const kol = typeof json.kol_count === 'number' && Number.isFinite(json.kol_count) ? json.kol_count : null;
    let createdAt: number | null = null;
    if (typeof json.created_at === 'string') {
      const ms = Date.parse(json.created_at);
      if (Number.isFinite(ms)) createdAt = Math.floor(ms / 1000);
    }
    return { kolCount: kol, createdAt };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve both fields for an address, memoized; concurrent callers share one request. */
export function pulseLookup(address: string): Promise<{ kolCount: number | null; createdAt: number | null }> {
  const hit = cache.get(address);
  if (hit) {
    const ttl = hit.kolCount == null && hit.createdAt == null ? NULL_TTL_MS : Math.max(KOL_TTL_MS, AGE_TTL_MS);
    if (Date.now() - hit.at < ttl) return Promise.resolve({ kolCount: hit.kolCount, createdAt: hit.createdAt });
  }
  const running = inflight.get(address);
  if (running) return running;
  const p = (async () => {
    let out: { kolCount: number | null; createdAt: number | null };
    try {
      out = await fetchPulse(address);
    } catch {
      out = { kolCount: null, createdAt: null };
    }
    cache.set(address, { ...out, at: Date.now() });
    return out;
  })();
  inflight.set(address, p);
  void p.finally(() => inflight.delete(address)).catch(() => {});
  return p;
}

/** Memoized-only read (never hits the network) — used to skip already-resolved records. */
export function pulseCached(address: string): { kolCount: number | null; createdAt: number | null } | null {
  const hit = cache.get(address);
  return hit ? { kolCount: hit.kolCount, createdAt: hit.createdAt } : null;
}

/**
 * Enrich the given records in place: `kol` resolves KOL counts, `age` resolves
 * missing creation times. Bounded-concurrency batches, only for records that are
 * missing the requested field. Returns how many records actually gained a value,
 * so callers can skip a pointless re-render.
 *
 * Both fields come from the same Pulse response, so asking for the age also fills
 * a KOL count when the endpoint reported one — free by-product, no extra request.
 */
export async function pulseEnrich(tokens: FomoToken[], opts: { kol?: boolean; age?: boolean }): Promise<number> {
  const targets = tokens.filter((t) => (opts.kol && t.kolCount == null) || (opts.age && t.createdAt == null));
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    await Promise.all(
      targets.slice(i, i + CONCURRENCY).map(async (t) => {
        const { kolCount, createdAt } = await pulseLookup(t.address);
        if (kolCount != null && (opts.kol || opts.age)) t.kolCount = kolCount;
        if (opts.age && createdAt != null) t.createdAt = createdAt;
      }),
    );
  }
  return targets.length;
}
