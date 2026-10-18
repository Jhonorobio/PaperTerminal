/**
 * WebSocket server — the app's single door to live data. Ported and trimmed from
 * `server con APIS/src/services/ws-server.js`.
 *
 * Protocol:
 *   Client → { action: 'subscribe', topic } | { action: 'unsubscribe', topic } | { action: 'ping' }
 *   Server → { topic, event, data }  (broadcast to everyone on the topic)
 *             { event: 'connected' } | { event: 'pong' }
 *
 * Topics:
 *   fomo_trending     — trending tokens (the only FOMO feed)
 *   memescope         — Photon columns { col1, col3 }
 *   track             — token tracker state (History → Track)
 *   track:health      — health chips of the tracked tokens (Trade/FOMO/Photon)
 *   alerts:{deviceId} — matched alerts for one device (the in-app panel + push mirror)
 */

import { WebSocketServer } from 'ws';

let wss = null;
const clients = new Set(); // { ws, subscriptions:Set<string> }
/** topic → () => payload|null: sent to a client the moment it subscribes. */
const topicProviders = new Map();

export function registerTopicProvider(topic, provider) {
  topicProviders.set(topic, provider);
}

export function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const client = { ws, subscriptions: new Set() };
    clients.add(client);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.action === 'subscribe' && typeof msg.topic === 'string') {
          client.subscriptions.add(msg.topic);
          const provider = topicProviders.get(msg.topic);
          if (provider) {
            try {
              const payload = provider();
              if (payload) sendTo(client, payload);
            } catch (err) {
              console.error(`[ws] provider ${msg.topic} failed:`, err.message);
            }
          }
        } else if (msg.action === 'unsubscribe' && typeof msg.topic === 'string') {
          client.subscriptions.delete(msg.topic);
        } else if (msg.action === 'ping') {
          ws.send(JSON.stringify({ event: 'pong' }));
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));

    ws.send(JSON.stringify({ event: 'connected', clients: clients.size }));
  });

  return wss;
}

export function sendTo(client, payload) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(payload));
}

/** Broadcast to every client subscribed to `topic`. */
export function broadcast(topic, payload) {
  if (!wss) return;
  const msg = JSON.stringify({ topic, ...payload });
  for (const client of clients) {
    if (client.subscriptions.has(topic) && client.ws.readyState === 1) client.ws.send(msg);
  }
}

/** Send to a single device's private topic (alerts). */
export function sendToDevice(deviceId, payload) {
  broadcast(`alerts:${deviceId}`, payload);
}

export function getSubscriptions() {
  const topics = new Set();
  for (const client of clients) for (const t of client.subscriptions) topics.add(t);
  return topics;
}

export function clientCount() {
  return clients.size;
}
