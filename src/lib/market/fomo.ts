/**
 * FOMO (fomo.family) market feed — graduated + trending tokens for Solana, spoken
 * to directly from the device. Ported from `server con APIS/src/services/fomo-ws.js`.
 *
 * One socket carries both feeds:
 *
 *   ← { type: 'challenge' }
 *   → { type: 'challengeResponse', jwt }            (Privy access token, ./fomo-auth)
 *   ← { type: 'challengeAccepted' }
 *   → { type: 'subscribe', topicType: 'graduated_tokens', topicId: '1399811149' }
 *   → { type: 'subscribe', topicType: 'trending_tokens',  topicId: '1399811149' }
 *   ← { type: 'subscribed', … }
 *   ← { topicType, payload: { kind: 'snapshot', tokens: [...] } }   — full list
 *   ← { topicType, payload: { kind: 'update', update, index } }    — delta (index = rank)
 *   ← { topicType, payload: { kind: 'remove', tokenKey } }
 *
 * Hardening ported from the server implementation:
 *   - the full subscription set is re-sent after every reconnect;
 *   - a data watchdog: FOMO's list always has activity, so a long silence means
 *     a zombie socket — close it and let the close handler reconnect;
 *   - close 1008 (policy violation) means the JWT was rejected → mint a fresh one;
 *   - listener notifications are batched (upstream sends ~100 msg/s).
 *
 * Not portable to React Native: custom handshake headers. The server sends
 * `origin`/`user-agent` because Cloudflare rejects datacenter IPs (HTTP 432);
 * a phone on a residential IP connects directly, so the headers are not needed.
 */

import type { FomoFeedId, FomoStatus, FomoToken } from '../types';
import { getAccessToken, hasCredentials, invalidateAccessToken } from './fomo-auth';

/** This direct socket only carries the two FOMO feeds; 'pump' lives on server-feed. */
type FomoSocketFeedId = Exclude<FomoFeedId, 'pump'>;

const FOMO_WS_URL = 'wss://prod-api.fomo.family/ws';
const GRADUATED_TYPE = 'graduated_tokens';
const TRENDING_TYPE = 'trending_tokens';
const SOLANA_TOPIC_ID = '1399811149';

const RECONNECT_MS = 3_000;
/** Upstream activity is constant; no message for this long → zombie socket. */
const DATA_TIMEOUT_MS = 120_000;
const WATCHDOG_MS = 15_000;
/** Listener notification batch — upstream sends ~100 msg/s. */
const NOTIFY_MS = 120;
const MAX_TOKENS = 5_000;

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

function normalize(item: unknown): FomoToken | null {
  const it = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
  const t = (it.token && typeof it.token === 'object' ? it.token : {}) as Record<string, unknown>;
  const address = str(t.address);
  if (!address) return null;
  const info = (t.info && typeof t.info === 'object' ? t.info : {}) as Record<string, unknown>;
  const launchpad = (t.launchpad && typeof t.launchpad === 'object' ? t.launchpad : {}) as Record<string, unknown>;
  return {
    address,
    symbol: str(t.symbol),
    name: str(t.name),
    image: str(info.imageThumbUrl),
    launchpad: str(launchpad.launchpadName),
    createdAt: num(it.createdAt), // unix seconds
    mcap: num(it.marketCap),
    price: num(it.priceUSD),
    vol24: num(it.volume24),
    change24: num(it.change24),
    holders: num(it.holders),
    updatedAt: Date.now(),
  };
}

type Listener = () => void;

class FomoFeed {
  private ws: WsLike | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMsgAt = 0;
  private lastError: string | null = null;
  private subscribed = false;
  /** Arrival timestamps of data messages — feeds the "msg/s" readout in the status pill. */
  private readonly arrivals: number[] = [];

  // 'pump' lives on the server feed (server-feed.ts), not on this direct FOMO socket.
  private readonly maps: Record<FomoSocketFeedId, Map<string, FomoToken>> = { graduated: new Map(), trending: new Map() };
  private readonly listeners = new Set<Listener>();

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    if (!wsCtor()) {
      this.lastError = 'no global WebSocket in this runtime';
      return;
    }
    this.running = true;
    this.connect();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this.checkWatchdog(), WATCHDOG_MS);
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already gone */
      }
      this.ws = null;
    }
    // Keep maps and listeners: a stop/start cycle (app backgrounded) keeps the data.
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.start();
    return () => this.listeners.delete(listener);
  }

  // ─── reads ─────────────────────────────────────────────────────────────────

  tokens(feed: FomoSocketFeedId): FomoToken[] {
    return [...this.maps[feed].values()];
  }

  status(): FomoStatus {
    const open = Boolean(this.ws && this.ws.readyState === 1);
    return {
      connected: open,
      authenticated: this.subscribed,
      live: Boolean(open && this.subscribed && this.lastMsgAt && Date.now() - this.lastMsgAt < 60_000),
      updatesPerSec: this.arrivals.length,
      graduatedCount: this.maps.graduated.size,
      trendingCount: this.maps.trending.size,
      lastError: this.lastError,
      hasRefreshToken: hasCredentials(),
    };
  }

  // ─── protocol ──────────────────────────────────────────────────────────────

  private connect(): void {
    if (!this.running) return;
    const Ctor = wsCtor();
    if (!Ctor) return;
    if (!hasCredentials()) {
      this.lastError = 'no refresh token — set EXPO_PUBLIC_FOMO_REFRESH_TOKEN';
      this.scheduleReconnect();
      return;
    }

    let ws: WsLike;
    try {
      ws = new Ctor(FOMO_WS_URL);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.subscribed = false;
    this.lastMsgAt = Date.now();

    ws.onopen = () => {
      this.lastMsgAt = Date.now();
    };

    ws.onmessage = (event) => {
      this.lastMsgAt = Date.now();
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleMessage(msg, ws);
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.subscribed = false;
      if (this.running) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // The close handler always follows; the message is generic in browsers.
    };
  }

  private handleMessage(msg: Record<string, unknown>, socket: WsLike): void {
    switch (msg.type) {
      case 'challenge':
        getAccessToken()
          .then((jwt) => {
            if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'challengeResponse', jwt }));
          })
          .catch((err: unknown) => {
            this.lastError = err instanceof Error ? err.message : String(err);
            try {
              socket.close();
            } catch {
              /* already gone */
            }
          });
        break;

      case 'challengeAccepted':
        for (const topicType of [GRADUATED_TYPE, TRENDING_TYPE]) {
          this.send(socket, { type: 'subscribe', topicType, topicId: SOLANA_TOPIC_ID });
        }
        break;

      case 'subscribed':
        this.subscribed = true;
        this.lastError = null;
        break;

      case 'error':
        this.lastError = typeof msg.message === 'string' ? msg.message : JSON.stringify(msg).slice(0, 300);
        break;

      case 'data': {
        // Both feeds demux by topicType; absent → graduated (the pre-trending shape).
        const topicType = msg.topicType === TRENDING_TYPE ? TRENDING_TYPE : GRADUATED_TYPE;
        const payload = (msg.payload && typeof msg.payload === 'object' ? msg.payload : {}) as Record<string, unknown>;
        this.applyData(topicType === TRENDING_TYPE ? 'trending' : 'graduated', payload);
        break;
      }

      default:
        break;
    }
  }

  private send(socket: WsLike, obj: unknown): void {
    if (socket.readyState === 1) {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* closed mid-send */
      }
    }
  }

  private applyData(feed: FomoSocketFeedId, p: Record<string, unknown>): void {
    const map = this.maps[feed];
    const ranked = feed === 'trending';

    // Arrival bookkeeping for the status readout: one data message = one count, 5s window.
    const now = Date.now();
    this.arrivals.push(now);
    while (this.arrivals.length && now - this.arrivals[0] > 5_000) this.arrivals.shift();

    if (p.kind === 'snapshot' && Array.isArray(p.tokens)) {
      map.clear();
      p.tokens.forEach((item, i) => {
        const rec = normalize(item);
        if (!rec) return;
        if (ranked) rec.rank = i; // the snapshot order IS the ranking
        map.set(rec.address, rec);
      });
      // Bound the map the way the server does (drop oldest graduations first).
      if (map.size > MAX_TOKENS) {
        const sorted = [...map.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        for (const rec of sorted.slice(0, map.size - MAX_TOKENS)) map.delete(rec.address);
      }
      this.subscribed = true;
      this.queueNotify();
    } else if (p.kind === 'update' && p.update) {
      const rec = normalize(p.update);
      if (rec) {
        const prev = map.get(rec.address);
        if (ranked && typeof p.index === 'number') rec.rank = p.index;
        else if (ranked && prev?.rank != null) rec.rank = prev.rank;
        // Upstream never repeats these — keep the values we resolved.
        if (prev?.kolCount != null && rec.kolCount == null) rec.kolCount = prev.kolCount;
        if (prev?.createdAt != null && rec.createdAt == null) rec.createdAt = prev.createdAt;
        map.set(rec.address, rec);
        this.queueNotify();
      }
    } else if (p.kind === 'remove' && typeof p.tokenKey === 'string') {
      // tokenKey = `${address}:${networkId}`
      const address = p.tokenKey.split(':')[0];
      if (map.delete(address)) this.queueNotify();
    }
  }

  /** Batch listener notifications: at most one per NOTIFY_MS window. */
  private queueNotify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const listener of [...this.listeners]) listener();
    }, NOTIFY_MS);
  }

  // ─── watchdog / reconnect ──────────────────────────────────────────────────

  private checkWatchdog(): void {
    if (!this.running) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    if (this.lastMsgAt && Date.now() - this.lastMsgAt > DATA_TIMEOUT_MS) {
      this.lastError = 'feed silent — restarting';
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  /** The feed's own update rate over the last 5 seconds — what actually arrives from FOMO. */
  updatesPerSec(): number {
    const now = Date.now();
    while (this.arrivals.length && now - this.arrivals[0] > 5_000) this.arrivals.shift();
    return Math.round((this.arrivals.length / 5) * 10) / 10;
  }
}

const feed = new FomoFeed();

export const fomoFeed = {
  start: () => feed.start(),
  stop: () => feed.stop(),
  subscribe: (listener: Listener) => feed.subscribe(listener),
  tokens: (id: FomoSocketFeedId) => feed.tokens(id),
  status: () => feed.status(),
  updatesPerSec: () => feed.updatesPerSec(),
  /** Drop the cached Privy token so the next challenge mints a fresh one. */
  resetAuth: () => invalidateAccessToken(),
};
