/**
 * Health chips of the TRACKED tokens, shared by Trade, FOMO and Photon.
 *
 * The tracker only knows the tokens it follows (Photon's Graduated column ∩ your
 * track filters), so the chip only exists where that address is being tracked —
 * everywhere else there is no series and thus no chip (no data, not a bug).
 *
 * It rides its own WS topic (`track:health` — address + health, ~30 bytes per
 * token), refcounted: the first screen that needs it subscribes (the server
 * pushes only while someone is), the last one to unmount unsubscribes. One HTTP
 * fetch covers the first paint and a dead socket.
 *
 * The map's IDENTITY only changes when some chip actually changed: screens hold
 * it in state, so a push that moves nothing re-renders nobody.
 */

import { useEffect, useState } from 'react';

import { fetchTrack, type TrackHealth, type TrackState } from '../track';
import { serverFeed, ServerFeed, TOPICS } from './server-feed';

type HealthPayload = { tokens?: { address?: string; health?: TrackHealth }[] };

let healthByAddress = new Map<string, TrackHealth>();
const listeners = new Set<() => void>();
let refs = 0;
let offTopic: (() => void) | null = null;

const notify = () => {
  for (const listener of [...listeners]) listener();
};

function apply(payload: HealthPayload | TrackState | null | undefined) {
  const tokens = (payload as HealthPayload | null)?.tokens;
  if (!Array.isArray(tokens)) return;
  const next = new Map<string, TrackHealth>();
  for (const t of tokens) {
    // Addresses ride as-is over the wire; lowercase is the app-wide lookup key.
    if (t?.address) next.set(t.address.toLowerCase(), t.health ?? null);
  }
  let same = next.size === healthByAddress.size;
  if (same) {
    for (const [address, health] of next) {
      if (healthByAddress.get(address) !== health) {
        same = false;
        break;
      }
    }
  }
  if (same) return; // identity preserved → every consumer bails out of the render
  healthByAddress = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function acquire(serverBase: string): () => void {
  refs += 1;
  if (refs === 1) {
    // First screen that cares: current chips for the first paint, then pushes.
    void fetchTrack(serverBase).then(apply).catch(() => {});
    offTopic = serverFeed.onTopic(TOPICS.trackHealth, (data) => apply(data as HealthPayload));
    serverFeed.subscribeTopic(TOPICS.trackHealth);
    void ServerFeed.ensureConnected(serverBase);
  }
  return () => {
    refs -= 1;
    if (refs > 0) return;
    // Last consumer gone: stop the pushes — a screen nobody is looking at must
    // not cost the phone anything.
    offTopic?.();
    offTopic = null;
    serverFeed.unsubscribeTopic(TOPICS.trackHealth);
  };
}

/**
 * Map of tracked address (lowercase) → health chip. Stable identity across
 * pushes that change nothing, so passing it to memoized rows is free.
 */
export function useTrackHealth(serverBase: string): Map<string, TrackHealth> {
  const [map, setMap] = useState(healthByAddress);
  useEffect(() => {
    const release = acquire(serverBase);
    const off = subscribe(() => setMap(healthByAddress));
    return () => {
      off();
      release();
    };
  }, [serverBase]);
  return map;
}
