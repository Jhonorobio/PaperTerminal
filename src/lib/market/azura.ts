/**
 * Azura WSS market feed — the app's price source, spoken to directly from the device (there is no
 * backend of our own anymore). One socket carries every subscribed token:
 *
 *   → { type: 'subscribe', payload: { chain_id: 1399811149, pool: '<mint>',
 *                                     subscription_types: ['explorerCard'] } }
 *   ← { type: 'explorerCard', chainId, tokenAddress, payload: { stats: { price: { usd, native },
 *        marketCap, liquidity, volume }, metadata: { symbol, name, image }, security, ... } }
 *
 * Verified live: `stats.price.usd` is the USD price (the parser this is based on missed it), and
 * `explorerCard` is the only subscription type the server accepts — anything else answers HTTP-ish
 * `{ type: 'error', code: 400 }`. No API key, no auth, no CORS (native React Native has no CORS
 * enforcement anyway).
 *
 * Hardening ported from the server implementation this replaces:
 *   - the full subscription set is re-sent on every `open`, so reconnects are transparent;
 *   - a silent watchdog: the socket can stay open while Azura stops pushing (seen in production —
 *     every mcap froze at once). No message for SILENT_MS → terminate and reconnect;
 *   - ping/pong is deliberately absent: React Native's WebSocket has no `ping()`, and the
 *     silent-restart covers the same failure without it.
 */

/** Azura's internal Solana chain id. Other chains are not subscribed yet — see `../market`. */
export const AZURA_SOLANA_CHAIN_ID = 1399811149;

const AZURA_URL = 'wss://data.v2.azura.xyz/ws';
const SILENT_MS = 60_000; // no message for this long → socket considered dead
const RECONNECT_MS = 3_000;
const WATCHDOG_MS = 10_000; // how often the silent check runs

export interface AzuraSnapshot {
  /** Azura chain id (number), e.g. 1399811149 for Solana. */
  chainId: number;
  /** Token mint. */
  address: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  priceUsd: number;
  priceNative: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  /** Percentage, e.g. -2.22 for -2.22%. */
  change24hPct: number | null;
  holders: number | null;
  dex: string | null;
  lastTradeAt: string | null;
  /** Local arrival time, for staleness checks. */
  fetchedAt: number;
}

type Listener = (snapshot: AzuraSnapshot) => void;

/**
 * The subset of the browser/RN WebSocket API this client uses. Declared structurally instead of
 * relying on the platform's global typings, so the same code typechecks under `lib: dom` and under
 * React Native's.
 */
interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

type WsCtor = new (url: string) => WsLike;

function wsCtor(): WsCtor | null {
  const g = globalThis as { WebSocket?: WsCtor };
  return g.WebSocket ?? null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Azura prefixes symbols with `$`; the rest of the app expects the bare ticker. */
const cleanSymbol = (v: unknown): string | null => {
  const s = str(v);
  return s ? s.replace(/^\$/, '').toUpperCase() : null;
};

// ─── parser ─────────────────────────────────────────────────────────────────

/**
 * Maps one explorerCard frame to a snapshot. Every field is defensive: an upstream payload tweak
 * degrades one metric, it never throws and kills the socket.
 */
export function parseExplorerCard(frame: unknown): AzuraSnapshot | null {
  if (!frame || typeof frame !== 'object') return null;
  const j = frame as Record<string, unknown>;
  if (j.type !== 'explorerCard') return null;

  const p = (j.payload && typeof j.payload === 'object' ? j.payload : {}) as Record<string, unknown>;
  const meta = (p.metadata && typeof p.metadata === 'object' ? p.metadata : {}) as Record<string, unknown>;
  const stats = (p.stats && typeof p.stats === 'object' ? p.stats : {}) as Record<string, unknown>;
  const price = (stats.price && typeof stats.price === 'object' ? stats.price : {}) as Record<string, unknown>;
  const change = (price.change && typeof price.change === 'object' ? price.change : {}) as Record<string, unknown>;
  const liquidity = stats.liquidity as Record<string, unknown> | undefined;
  const liqAmount = liquidity && typeof liquidity === 'object' ? (liquidity.amount as Record<string, unknown> | undefined) : undefined;
  const volume = stats.volume as Record<string, unknown> | undefined;
  const vol24 = volume && typeof volume === 'object' ? (volume['24h'] as Record<string, unknown> | undefined) : undefined;
  const image = meta.image as Record<string, unknown> | undefined;

  const address = str(p.tokenAddress) ?? str(meta.tokenAddress) ?? str(j.tokenAddress);
  const priceUsd = num(price.usd);
  if (!address || priceUsd === null || priceUsd <= 0) return null;

  return {
    chainId: num(j.chainId) ?? num(p.chainId) ?? AZURA_SOLANA_CHAIN_ID,
    address,
    symbol: cleanSymbol(meta.symbol),
    name: str(meta.name),
    imageUrl: str(image?.url),
    priceUsd,
    priceNative: num(price.native),
    liquidityUsd: num(liqAmount?.usd),
    marketCapUsd: num(stats.marketCap),
    volume24hUsd: num(vol24?.usd),
    change24hPct: num(change['24h']),
    holders: num(p.holders) ?? num(stats.holders),
    dex: str(p.dex) ?? str(meta.dex),
    lastTradeAt: str(p.lastTrade),
    fetchedAt: Date.now(),
  };
}

// ─── singleton feed ──────────────────────────────────────────────────────────

class AzuraFeed {
  private ws: WsLike | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private snapshots = new Map<string, AzuraSnapshot>();
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastMsgAt = 0;

  /** Opens the socket if needed. Safe to call on every subscribe. */
  start(): void {
    if (this.running) return;
    if (!wsCtor()) {
      console.warn('[azura] no global WebSocket in this runtime');
      return;
    }
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already gone */
      }
      this.ws = null;
    }
    // Keep listeners and snapshots: a stop/start cycle (app backgrounded) should not force every
    // screen to re-subscribe. Only `stopAzura()` clears the world.
  }

  /** Last snapshot received for a mint, or null. */
  snapshot(address: string): AzuraSnapshot | null {
    return this.snapshots.get(address) ?? null;
  }

  subscribe(address: string, listener: Listener): () => void {
    if (!address) return () => {};
    let set = this.listeners.get(address);
    if (!set) {
      set = new Set();
      this.listeners.set(address, set);
    }
    set.add(listener);
    this.start();
    this.send({ type: 'subscribe', payload: { chain_id: AZURA_SOLANA_CHAIN_ID, pool: address, subscription_types: ['explorerCard'] } });
    return () => {
      const current = this.listeners.get(address);
      if (!current) return;
      current.delete(listener);
      if (!current.size) {
        this.listeners.delete(address);
        this.send({ type: 'unsubscribe', payload: { chain_id: AZURA_SOLANA_CHAIN_ID, pool: address, subscription_types: ['explorerCard'] } });
      }
    };
  }

  status() {
    const count = [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
    return {
      running: this.running,
      connected: this.ws != null && this.ws.readyState === 1,
      subscriptions: count,
      lastMsgAgeMs: this.lastMsgAt ? Date.now() - this.lastMsgAt : null,
    };
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        /* closed mid-send */
      }
    }
  }

  private connect(): void {
    if (!this.running) return;
    const Ctor = wsCtor();
    if (!Ctor) return;

    let ws: WsLike;
    try {
      ws = new Ctor(AZURA_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastMsgAt = Date.now();

    ws.onopen = () => {
      if (!this.running) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        return;
      }
      // Re-send the whole subscription set: the socket forgot everything on reconnect.
      for (const address of this.listeners.keys()) {
        this.send({ type: 'subscribe', payload: { chain_id: AZURA_SOLANA_CHAIN_ID, pool: address, subscription_types: ['explorerCard'] } });
      }
      this.lastMsgAt = Date.now();
      this.startWatchdog();
    };

    ws.onmessage = (event) => {
      this.lastMsgAt = Date.now();
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      const snap = parseExplorerCard(frame);
      if (!snap) return;
      this.snapshots.set(snap.address, snap);
      const set = this.listeners.get(snap.address);
      if (set) for (const listener of [...set]) listener(snap);
    };

    ws.onerror = () => {
      // The close handler always follows; nothing to do but note it.
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      if (this.running) this.scheduleReconnect();
    };
  }

  /**
   * Open-but-dead sockets are the real failure mode (Azura stops pushing while keeping the
   * connection). No message for SILENT_MS → terminate; the close handler reconnects and re-sends
   * every subscription.
   */
  private startWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (!this.running) return;
      if (this.lastMsgAt && Date.now() - this.lastMsgAt > SILENT_MS) {
        const ws = this.ws;
        if (ws) {
          try {
            ws.close();
          } catch {
            /* noop */
          }
        }
      }
    }, WATCHDOG_MS);
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }
}

const feed = new AzuraFeed();

export const azuraFeed = {
  subscribe: (address: string, listener: Listener) => feed.subscribe(address, listener),
  snapshot: (address: string) => feed.snapshot(address),
  status: () => feed.status(),
  start: () => feed.start(),
  stop: () => feed.stop(),
};
