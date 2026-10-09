/**
 * Trenchers Pulse — keyless per-token enrichment: KOL count and creation time.
 * Ported from `server con APIS/src/services/pulse-kol.js` + `token-age.js`.
 *
 *   GET https://pulse-production.trenchers.ai/pulse/token/{address}
 *   → { kol_count?: number, created_at?: string }
 *
 * Used by FOMO filters (age on trending, KOL bounds) exactly like the original.
 */

const PULSE_URL = 'https://pulse-production.trenchers.ai/pulse/token';
const FETCH_TIMEOUT_MS = 15_000;
const KOL_TTL_MS = 5 * 60_000;
const AGE_TTL_MS = 15 * 60_000;
const NULL_TTL_MS = 60_000;

const cache = new Map(); // address → { kolCount, createdAt, at }
const inflight = new Map();

async function fetchPulse(address) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${PULSE_URL}/${encodeURIComponent(address)}`, {
      headers: { accept: '*/*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const kol = typeof json.kol_count === 'number' && Number.isFinite(json.kol_count) ? json.kol_count : null;
    let createdAt = null;
    if (typeof json.created_at === 'string') {
      const ms = Date.parse(json.created_at);
      if (Number.isFinite(ms)) createdAt = Math.floor(ms / 1000);
    }
    return { kolCount: kol, createdAt };
  } finally {
    clearTimeout(timer);
  }
}

export function pulseLookup(address) {
  const hit = cache.get(address);
  if (hit) {
    const ttl = hit.kolCount == null && hit.createdAt == null ? NULL_TTL_MS : Math.max(KOL_TTL_MS, AGE_TTL_MS);
    if (Date.now() - hit.at < ttl) return Promise.resolve({ kolCount: hit.kolCount, createdAt: hit.createdAt });
  }
  const running = inflight.get(address);
  if (running) return running;
  const p = (async () => {
    let out;
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

/** Memoized read only — never hits the network. */
export function pulseCached(address) {
  const hit = cache.get(address);
  return hit ? { kolCount: hit.kolCount, createdAt: hit.createdAt } : null;
}

const CONCURRENCY = 25;

/** Enrich records in place; returns how many gained a value. */
export async function pulseEnrich(tokens, opts) {
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
