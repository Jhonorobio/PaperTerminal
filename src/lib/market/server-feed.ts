/**
 * Server feed client — the app's only door to FOMO and Photon.
 *
 * One WebSocket to the feed server (settings.serverBase, http→ws). Topics:
 *   fomo | fomo_trending   → { event: 'fomo_updated',        data: { tokens, savedAt, snapshot } }
 *   memescope             → { event: 'memescope_updated',    data: { columns: { col1, col3 }, … } }
 *   alerts:{deviceId}     → { event: 'alert',                data: <history entry> }
 *
 * The phone no longer talks to FOMO or Photon directly: no Privy token, no
 * Cloudflare — the server keeps those connections and pushes here. Every
 * broadcast carries the topic's full list (snapshot semantics), so a reconnect
 * or a dropped frame self-heals on the next push.
 */

import { getDeviceId } from '../device-id';
import type { FomoToken, PhotonSnapshot } from '../types';

export const TOPICS = {
  graduated: 'fomo',
  trending: 'fomo_trending',
  memescope: 'memescope',
  alerts: 'alerts',
} as const;

type Listener = () => void;
type AlertListener = (entry: unknown) => void;

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

const CONNECT_DEBOUNCE_MS = 400;
const PING_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;

function wsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.replace(/^http/, 'ws') + '/ws';
}

class ServerFeed {
  private ws: WsLike | null = null;
  private base: string | null = null;
  private deviceId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPongAt = 0;
  private everConnected = false;
  private lastError: string | null = null;

  /** address → token, per feed topic. */
  private readonly fomoMaps = { fomo: new Map<string, FomoToken>(), fomo_trending: new Map<string, FomoToken>() };
  private memescope: PhotonSnapshot | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly alertListeners = new Set<AlertListener>();

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** (Re)connects with a new base/device; safe to call on every app open. */
  connect(base: string, deviceId: string): void {
    const next = base.replace(/\/+$/, '');
    if (this.base === next && this.deviceId === deviceId && this.ws) return;
    this.base = next;
    this.deviceId = deviceId;
    this.teardownSocket();
    this.connectSoon();
  }

  disconnect(): void {
    this.base = null;
    this.deviceId = null;
    this.teardownSocket();
  }

  private connectSoon(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, CONNECT_DEBOUNCE_MS);
  }

  private teardownSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already gone */
      }
      this.ws = null;
    }
  }

  private openSocket(): void {
    if (!this.base || !this.deviceId) return;
    const Ctor = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
    if (!Ctor) {
      this.lastError = 'no WebSocket runtime';
      return;
    }

    let ws: WsLike;
    try {
      ws = new Ctor(wsUrl(this.base));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.connectSoon();
      return;
    }
    this.ws = ws;
    this.lastPongAt = Date.now();

    ws.onopen = () => {
      this.everConnected = true;
      this.lastError = null;
      this.lastPongAt = Date.now();
      const deviceId = this.deviceId as string;
      this.send({ action: 'subscribe', topic: TOPICS.graduated });
      this.send({ action: 'subscribe', topic: TOPICS.trending });
      this.send({ action: 'subscribe', topic: TOPICS.memescope });
      this.send({ action: 'subscribe', topic: `${TOPICS.alerts}:${deviceId}` });
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.keepAlive(ws), PING_MS);
    };

    ws.onmessage = (event) => {
      this.lastPongAt = Date.now();
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      let msg: { topic?: string; event?: string; data?: unknown };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.event === 'pong' || msg.event === 'connected') return;
      this.handle(msg);
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      // Persistent reconnect: the phone may be on flaky mobile data.
      this.connectSoon();
    };

    ws.onerror = () => {
      this.lastError = 'socket error';
    };
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        /* closed mid-send */
      }
    }
  }

  private keepAlive(ws: WsLike): void {
    if (ws.readyState !== 1) return;
    if (Date.now() - this.lastPongAt > PING_MS + PONG_TIMEOUT_MS) {
      this.lastError = 'server silent';
      try {
        ws.close();
      } catch {
        /* reconnect from close */
      }
      return;
    }
    this.send({ action: 'ping' });
  }

  private handle(msg: { topic?: string; data?: unknown }): void {
    const topic = msg.topic ?? '';
    const data = (msg.data ?? {}) as {
      tokens?: FomoToken[];
      columns?: Record<string, { data?: { attributes?: Record<string, unknown> }[] }>;
      address?: string;
      symbol?: string;
      mcap?: number;
      category?: string;
    };

    if (topic === TOPICS.graduated || topic === TOPICS.trending) {
      const map = topic === TOPICS.trending ? this.fomoMaps.fomo_trending : this.fomoMaps.fomo;
      if (Array.isArray(data.tokens)) {
        map.clear();
        for (const token of data.tokens) map.set(token.address, token);
      }
    } else if (topic === TOPICS.memescope) {
      this.memescope = data as unknown as PhotonSnapshot;
    } else if (topic.startsWith(`${TOPICS.alerts}:`)) {
      for (const listener of [...this.alertListeners]) listener(data);
      return; // alerts do not repaint the feed lists
    }

    for (const listener of [...this.listeners]) listener();
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  tokens(topic: 'fomo' | 'fomo_trending'): FomoToken[] {
    return [...(topic === 'fomo_trending' ? this.fomoMaps.fomo_trending : this.fomoMaps.fomo).values()];
  }

  memescopeSnapshot(): PhotonSnapshot | null {
    return this.memescope;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAlert(listener: AlertListener): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }

  status() {
    return {
      connected: Boolean(this.ws && this.ws.readyState === 1),
      everConnected: this.everConnected,
      lastError: this.lastError,
      base: this.base,
    };
  }

  /** Exposed for the Settings health check: async because the device id is stored. */
  static async ensureConnected(base: string): Promise<string> {
    const deviceId = await getDeviceId();
    const feed = serverFeed;
    feed.connect(base, deviceId);
    return deviceId;
  }
}

export const serverFeed = new ServerFeed();
export { ServerFeed };
