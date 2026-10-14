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
  { key: 'topHolders', label: 'Top Holders %' },
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
/** The server-computed health pill of a tracked token — read from its own series. */
export type TrackHealth = 'green' | 'amber' | 'red' | null;
/**
 * The server-computed BUY signal (entry profile + minute-3 momentum, validated
 * at the minute-3 price): 'buy' all four conditions met · 'avoid' fails the
 * entry profile (bots ≥150, holders ≥300 or snipers ≥1%) · null until there
 * are 3 snapshots to judge.
 */
export type TrackBuySignal = 'buy' | 'avoid' | null;

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
  /** Trenchers Pulse (fuente 2): % de wallets clasificadas como insiders. */
  insiderPct: number | null;
  /** Trenchers Pulse: % de traders inteligentes (rentables) dentro. */
  smartTraderPct: number | null;
  /** Trenchers Pulse: cantidad de pro traders. */
  proTraders: number | null;
  /** Trenchers Pulse: cantidad de KOLs dentro del token. */
  kolCount: number | null;
  /** Trenchers Pulse: historial del dev — mints que creó y cuántos graduaron. */
  creatorMints: number | null;
  creatorGraduated: number | null;
  /** Azura: veredicto de seguridad del contrato (LOW / MEDIUM / HIGH). */
  overallSecurity: string | null;
  /** Azura: flags de auditoría encendidos ([] = limpia; ej: "washTrading"). */
  securityFlags: string[] | null;
  /** Azura: cambio del volumen en % — ¿se acelera (+) o se muere (−)? */
  volChange5m: number | null;
  volChange1h: number | null;
  /** Azura: volumen en $ compras vs ventas (ventanas 5m y 1h). */
  buyVol5m: number | null;
  sellVol5m: number | null;
  buyVol1h: number | null;
  sellVol1h: number | null;
  /** Azura: pro traders de AZURA (métrica distinta a la de Pulse). */
  proTradersAz: number | null;
  /**
   * The chip as it looked AT THAT MINUTE (server computes it from the prefix
   * [0..i] of the series — no hindsight). null on the first snapshot.
   */
  health: TrackHealth;
  /** Volume ÷ mcap at that minute — the turnover the chip watches. */
  turnover: number | null;
  /** The buy signal as it looked AT THAT MINUTE (prefix [0..i], no hindsight). */
  buySignal: TrackBuySignal;
  /** COMPRAR FUERTE at that minute: buy + bundle quiet (<1.4x growth). */
  strongBuy: boolean;
  /** WATCH at that minute: green + quiet bundle, not buy (informativo). */
  watchSignal: boolean;
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
  /** Highest market cap seen while tracked, and the gain first→max (percent). */
  maxMcap: number | null;
  gainPct: number | null;
  /**
   * Health chip (from the snapshot series): 'green' holders growing + net
   * buying · 'red' holders bleeding or selling pressure · 'amber' mixed.
   * null until there are ≥2 snapshots to judge.
   */
  health: TrackHealth;
  /**
   * Buy signal (from the snapshot series): 'buy' = entry profile (bots <150,
   * holders <300, snipers <1% when reported — a missing value needs a quiet
   * bundle <1.4x instead) + mcap up at minute 3 — measured 62% positive from
   * the minute-3 price vs 26% for the rest. 'avoid' = fails the entry profile
   * (74% ended below). null until 3 snapshots exist.
   */
  buySignal: TrackBuySignal;
  /**
   * COMPRAR FUERTE: buy + bundle quiet <1.4x — the intersection measured 75%
   * positive / +109% median / +236% peak, the strongest cell found so far
   * (experimental: the sample is still small).
   */
  strongBuy: boolean;
  /**
   * WATCH (chip B): health green + bundle quiet <1.4x and not buy — 50%
   * positive but +106% median peak (with TP+100%/SL−20 the median outcome is
   * +100%). Informational, no alert: it exists to be watched, not chased.
   */
  watchSignal: boolean;
  /** Latest snapshot's Trenchers Pulse reading — null on older tokens. */
  insiderPct: number | null;
  smartTraderPct: number | null;
  proTraders: number | null;
  kolCount: number | null;
  creatorMints: number | null;
  creatorGraduated: number | null;
  /** Latest snapshot's Azura reading — security verdict + triggered flags. */
  overallSecurity: string | null;
  securityFlags: string[] | null;
  /** Latest snapshot's volume rhythm (% change) and $ buy vs sell split. */
  volChange5m: number | null;
  volChange1h: number | null;
  buyVol5m: number | null;
  sellVol5m: number | null;
  buyVol1h: number | null;
  sellVol1h: number | null;
  /** Azura's own pro-trader count (different metric than Pulse's `proTraders`). */
  proTradersAz: number | null;
  /** Holders first→last snapshot, percent (the strongest signal, r=0.71). */
  holdersDeltaPct: number | null;
  /** Buys/sells over the last ~3 min — ≥1 means net buying. */
  flowRatio: number | null;
  /** Volume ÷ mcap right now — ≥10x means distribution (they're exiting). */
  turnover: number | null;
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
  /** Column pulls (presence/identity) — the fast cadence. */
  pullMs: number;
  /** Per-token stats snapshots — one per minute. */
  snapshotMs: number;
  /** 30 continuous minutes out of the column end the run ("Cortado"). */
  pauseCutMs: number;
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
