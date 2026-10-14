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

import { fetchTrack, type TrackBuySignal, type TrackHealth, type TrackState } from '../track';
import { serverFeed, ServerFeed, TOPICS } from './server-feed';

/** Both chips the tracker computes per address (health pill + buy signal). */
export type TrackChips = {
  health: TrackHealth;
  buySignal: TrackBuySignal;
  strongBuy: boolean;
  watchSignal: boolean;
};

type HealthPayload = {
  tokens?: {
    address?: string;
    health?: TrackHealth;
    buySignal?: TrackBuySignal;
    strongBuy?: boolean;
    watchSignal?: boolean;
  }[];
};

let chipsByAddress = new Map<string, TrackChips>();
const listeners = new Set<() => void>();
let refs = 0;
let offTopic: (() => void) | null = null;

const notify = () => {
  for (const listener of [...listeners]) listener();
};

function apply(payload: HealthPayload | TrackState | null | undefined) {
  const tokens = (payload as HealthPayload | null)?.tokens;
  if (!Array.isArray(tokens)) return;
  const next = new Map<string, TrackChips>();
  for (const t of tokens) {
    // Addresses ride as-is over the wire; lowercase is the app-wide lookup key.
    if (t?.address)
      next.set(t.address.toLowerCase(), {
        health: t.health ?? null,
        buySignal: t.buySignal ?? null,
        strongBuy: Boolean(t.strongBuy),
        watchSignal: Boolean(t.watchSignal),
      });
  }
  let same = next.size === chipsByAddress.size;
  if (same) {
    for (const [address, chips] of next) {
      const prev = chipsByAddress.get(address);
      if (
        !prev ||
        prev.health !== chips.health ||
        prev.buySignal !== chips.buySignal ||
        prev.strongBuy !== chips.strongBuy ||
        prev.watchSignal !== chips.watchSignal
      ) {
        same = false;
        break;
      }
    }
  }
  if (same) return; // identity preserved → every consumer bails out of the render
  chipsByAddress = next;
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
 * Map of tracked address (lowercase) → { health, buySignal } chips. Stable
 * identity across pushes that change nothing, so passing it to memoized rows
 * is free.
 */
export function useTrackHealth(serverBase: string): Map<string, TrackChips> {
  const [map, setMap] = useState(chipsByAddress);
  useEffect(() => {
    const release = acquire(serverBase);
    const off = subscribe(() => setMap(chipsByAddress));
    return () => {
      off();
      release();
    };
  }, [serverBase]);
  return map;
}
