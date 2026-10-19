/**
 * Server feed client — the app's only door to FOMO.
 *
 * One WebSocket to the feed server (settings.serverBase, http→ws). Topics:
 *   fomo_trending         → { event: 'fomo_trending_updated', data: { tokens, savedAt, snapshot } }
 *   alerts:{deviceId}     → { event: 'alert',                data: <history entry> }
 *   track / track:health  → the tracker's full state / health chips
 *
 * The phone no longer talks to FOMO directly: no Privy token, no Cloudflare —
 * the server keeps that connection and pushes here. Every broadcast carries the
 * topic's full list (snapshot semantics), so a reconnect or a dropped frame
 * self-heals on the next push.
 */

import { getDeviceId } from '../device-id';
import type { FomoToken } from '../types';

export const TOPICS = {
  trending: 'fomo_trending',
  alerts: 'alerts',
  /** Token tracker state (Track tab) — subscribed only while that tab is open. */
  track: 'track',
  /** Health chips of the tracked tokens (Trade/FOMO) — light payload. */
  trackHealth: 'track:health',
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

  /** address → token, the trending feed. */
  private readonly trending = new Map<string, FomoToken>();
  /** Local clock of the last trending push. */
  private trendingAt = 0;
  private readonly listeners = new Set<Listener>();
  private readonly alertListeners = new Set<AlertListener>();
  /** Optional topics the app asked for (track, …) — subscribed on open + reconnect. */
  private readonly stickyTopics = new Set<string>();
  /** topic → listeners for the optional topics (payload per push). */
  private readonly topicListeners = new Map<string, Set<(data: unknown) => void>>();

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
      this.send({ action: 'subscribe', topic: TOPICS.trending });
      this.send({ action: 'subscribe', topic: `${TOPICS.alerts}:${deviceId}` });
      // Optional topics (track, …) must survive reconnects too.
      for (const topic of this.stickyTopics) this.send({ action: 'subscribe', topic });
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
      address?: string;
      symbol?: string;
      mcap?: number;
      category?: string;
    };

    if (topic === TOPICS.trending) {
      if (Array.isArray(data.tokens)) {
        this.trending.clear();
        for (const token of data.tokens) this.trending.set(token.address, token);
      }
      this.trendingAt = Date.now();
    } else if (topic.startsWith(`${TOPICS.alerts}:`)) {
      for (const listener of [...this.alertListeners]) listener(data);
      return; // alerts do not repaint the feed lists
    } else {
      // Optional topics (track, …): payload to their own listeners, and out —
      // they must never wake the feed lists' subscribers.
      const set = this.topicListeners.get(topic);
      if (set) for (const listener of [...set]) listener(data);
      return;
    }

    for (const listener of [...this.listeners]) listener();
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  tokens(): FomoToken[] {
    return [...this.trending.values()];
  }

  /** Epoch ms of the last trending push (0 = never). */
  trendingReceivedAt(): number {
    return this.trendingAt;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAlert(listener: AlertListener): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }

  /**
   * Opt a topic in: subscribed on the live socket (and on every reconnect) and
   * pushed by the server while anyone asks. Only the tab that uses it opts in,
   * so a phone that never opens Track never pays for it.
   */
  subscribeTopic(topic: string): void {
    this.stickyTopics.add(topic);
    this.send({ action: 'subscribe', topic });
  }

  unsubscribeTopic(topic: string): void {
    if (!this.stickyTopics.delete(topic)) return;
    this.send({ action: 'unsubscribe', topic });
  }

  /** Payload listener for an optional topic; returns the unsubscribe. */
  onTopic(topic: string, listener: (data: unknown) => void): () => void {
    let set = this.topicListeners.get(topic);
    if (!set) {
      set = new Set();
      this.topicListeners.set(topic, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.topicListeners.delete(topic);
    };
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
