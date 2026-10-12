/**
 * Track client — reads the server's token tracker (a second Photon Graduated
 * poller that snapshots the tokens passing the track's own filters, once a
 * minute, up to 50 snapshots per token).
 *
 * The data is global (not per-device): the same server tracks for whoever asks.
 */

const TIMEOUT_MS = 12_000;

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `HTTP_${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** The same field vocabulary as the Photon column filters (MC in thousands). */
export const TRACK_FILTER_FIELDS = [
  { key: 'age', label: 'Edad (min)' },
  { key: 'mktCap', label: 'MC ($K)' },
  { key: 'holders', label: 'Holders' },
  { key: 'tpHolders', label: 'TP Holders' },
  { key: 'buys', label: 'Compras' },
  { key: 'freshPct', label: 'Fresh %' },
  { key: 'bundleHolders', label: 'Bundle Holders' },
  { key: 'bundlePct', label: 'Bundle %' },
] as const;

export type TrackFilterKey = (typeof TRACK_FILTER_FIELDS)[number]['key'];

export interface TrackFilterPair {
  min?: string;
  max?: string;
}

export interface TrackConfig {
  enabled: boolean;
  /** The track's OWN proxy — never the shared FOMO/Photon one. '' = not configured. */
  proxy: string;
  filters: Partial<Record<TrackFilterKey, TrackFilterPair>>;
}

/** One minute of the token's stats — the exact shape the server snapshots. */
export interface TrackSnapshot {
  at: string;
  mcap: number | null;
  volume: number | null;
  buys: number | null;
  sells: number | null;
  holders: number | null;
  topHoldersPct: number | null;
  freshPct: number | null;
  freshHolders: number | null;
  snipersPct: number | null;
  snipers: number | null;
  bundlePct: number | null;
  bundleHolders: number | null;
  tpHolders: number | null;
}

export interface TrackTokenSummary {
  address: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  /** Last snapshot's market cap / volume — the row's "MC / VOL" line. */
  mcap: number | null;
  volume: number | null;
  /** 'active' = the track is still open (< 50 snapshots); 'done' = cut at 50. */
  status: 'active' | 'done';
  firstSeenAt: string;
  lastSeenAt: string;
  /** Currently visible in Photon's Graduated column (capture running). */
  visible: boolean;
  snapshotCount: number;
}

export interface TrackTokenDetail extends TrackTokenSummary {
  snapshots: TrackSnapshot[];
}

/** Why the tracker is (or isn't) allowed to run: its own proxy + ≥1 filter. */
export interface TrackGate {
  ok: boolean;
  proxy: { ok: boolean; url: string };
  filters: { ok: boolean; count: number };
}

export interface TrackStatus {
  running: boolean;
  enabled: boolean;
  gate: TrackGate;
  tickMs: number;
  snapshotMax: number;
  tokensMax: number;
  lastFetchAt: string | null;
  fetchCount: number;
  errorCount: number;
  lastError: { message: string; at: number } | null;
  transport: 'proxy' | 'direct';
  proxy: { url: string };
  counts: { total: number; active: number; done: number; visible: number };
}

export interface TrackState {
  config: TrackConfig;
  /** null only in the app's offline fallback (the server always sends one). */
  status: TrackStatus | null;
  tokens: TrackTokenSummary[];
}

export async function fetchTrack(base: string): Promise<TrackState> {
  return call<TrackState>(base, '/api/track');
}

export async function fetchTrackToken(base: string, address: string): Promise<TrackTokenDetail> {
  return call<TrackTokenDetail>(base, `/api/track/${encodeURIComponent(address)}`);
}

export async function saveTrackConfig(base: string, config: TrackConfig): Promise<TrackConfig> {
  return call<TrackConfig>(base, '/api/track/config', { method: 'PUT', body: JSON.stringify(config) });
}

/** Result of the "Probar" button — one real fetch through the given proxy. */
export interface ProxyTestResult {
  ok: boolean;
  proxy?: string;
  status?: number;
  ms: number;
  tokens?: number;
  stage?: 'config';
  error?: string;
}

/** Proves a proxy works before saving it; ''/omitted falls back to the saved one. */
export async function testTrackProxy(base: string, proxy?: string): Promise<ProxyTestResult> {
  return call<ProxyTestResult>(base, '/api/track/proxy-test', { method: 'POST', body: JSON.stringify({ proxy }) });
}

/** Wipes every tracked token (the "Borrar" button — the config stays). */
export async function clearTrackTokens(base: string): Promise<{ cleared: boolean }> {
  return call<{ cleared: boolean }>(base, '/api/track', { method: 'DELETE' });
}
