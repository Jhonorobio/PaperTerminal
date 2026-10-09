/**
 * Market facade — the app's only door to prices.
 *
 * Today the single source is the Azura WSS feed (`./azura`): the trade screen subscribes to the
 * selected mint, and every quote read is a local snapshot — no HTTP request per poll. A token that
 * is not trading emits nothing, so a snapshot older than `MARKET_QUOTE_TTL_MS` is treated as absent.
 *
 * Second source, coming later: the caller registers a fallback provider with
 * `registerFallbackProvider` (e.g. an HTTP endpoint for quiet tokens and non-Solana chains). When
 * registered it is consulted whenever a fresh WSS snapshot is missing, so screens keep working
 * while Azura is quiet. Nothing else in the app needs to change when that happens.
 *
 * Shapes returned here match what the screens already consume (`Quote` in `../types`), so the
 * swap is invisible to the UI.
 */

import type { Asset, Quote } from '../types';
import { ApiError } from '../errors';
import { azuraFeed, type AzuraSnapshot } from './azura';
import { MARKET_QUOTE_TTL_MS } from '../config';
import { PAPER_CONFIG, feeRateFor } from '../engine/rules';

export type { AzuraSnapshot };

/** Provider signature for the future fallback. It may return null to mean "I don't know either". */
export type FallbackQuoteProvider = (chain: string, address: string) => Promise<Quote | null>;

let fallbackProvider: FallbackQuoteProvider | null = null;

/**
 * Registers the fallback price source. Pass null to remove it. Intended for the connection that
 * will be provided later; until then Azura is the only source.
 */
export function registerFallbackProvider(provider: FallbackQuoteProvider | null): void {
  fallbackProvider = provider;
}

export function hasFallbackProvider(): boolean {
  return fallbackProvider !== null;
}

/**
 * Keeps a live subscription for every token the app asks about. Reads (`readQuote`) do not push
 * data on their own — without this the socket would never connect for a token nobody subscribed.
 * The set is capped: the oldest token is dropped once it grows past MAX_TRACKED (the trade screen
 * shows one token at a time; the rest are recents and portfolio rows).
 */
const MAX_TRACKED = 32;
const tracked = new Map<string, () => void>();

function ensureSubscribed(chain: string, address: string): void {
  if (!address || !chainSupportedByFeed(chain)) return;
  if (tracked.has(address)) return;
  if (tracked.size >= MAX_TRACKED) {
    const oldest = tracked.keys().next().value;
    if (oldest) {
      tracked.get(oldest)?.();
      tracked.delete(oldest);
    }
  }
  tracked.set(
    address,
    azuraFeed.subscribe(address, () => {
      /* snapshots are pulled synchronously via readQuote/lastKnownQuote */
    }),
  );
}

/** True for chains Azura's feed currently covers (Solana). */
export function chainSupportedByFeed(chain: string): boolean {
  return chain.toLowerCase() === 'solana';
}

/** Last snapshot age in ms, or null when there is none. */
export function quoteAgeMs(chain: string, address: string): number | null {
  if (!chainSupportedByFeed(chain)) return null;
  const snap = azuraFeed.snapshot(address);
  return snap ? Date.now() - snap.fetchedAt : null;
}

/** Synchronous snapshot read; null when absent or stale. */
export function readQuote(chain: string, address: string): Quote | null {
  if (!chainSupportedByFeed(chain)) return null;
  ensureSubscribed(chain, address);
  const snap = azuraFeed.snapshot(address);
  if (!snap) return null;
  if (Date.now() - snap.fetchedAt > MARKET_QUOTE_TTL_MS) return null;
  return toQuote(snap, chain);
}

/** The last known snapshot regardless of age — used to value positions when the feed goes quiet. */
export function lastKnownQuote(chain: string, address: string): Quote | null {
  if (!chainSupportedByFeed(chain)) return null;
  const snap = azuraFeed.snapshot(address);
  return snap ? toQuote(snap, chain) : null;
}

/** Public logo URL Azura reported for a token, if any. */
export function readLogo(chain: string, address: string): string | null {
  if (!chainSupportedByFeed(chain)) return null;
  return azuraFeed.snapshot(address)?.imageUrl ?? null;
}

/**
 * Fresh quote or throw. Resolution order: fresh WSS snapshot → registered fallback → error.
 * Errors carry a `MARKET_DATA_*` code so the trade screen can react (`use-trade.ts` checks the
 * prefix) instead of showing a generic failure.
 */
export async function fetchQuote(asset: Asset): Promise<Quote> {
  const live = readQuote(asset.chain, asset.address);
  if (live) return live;

  if (fallbackProvider) {
    try {
      const fromFallback = await fallbackProvider(asset.chain, asset.address);
      if (fromFallback && fromFallback.priceUsd > 0) return fromFallback;
    } catch {
      // fall through to the unified error below — the screen shows one message, not two
    }
  }

  if (!chainSupportedByFeed(asset.chain)) {
    throw new ApiError(502, 'MARKET_DATA_UNSUPPORTED_CHAIN', `No price feed for chain "${asset.chain}" (Solana only for now).`);
  }
  throw new ApiError(502, 'MARKET_DATA_UNAVAILABLE', 'No live price for this token — it may not be trading right now.');
}

/**
 * Subscribes to live updates for an asset. Returns an unsubscribe function; calling it twice is
 * safe. The trade screen holds one subscription for the token it is showing.
 */
export function subscribeQuote(asset: Asset, listener: (quote: Quote) => void): () => void {
  if (!chainSupportedByFeed(asset.chain)) return () => {};
  return azuraFeed.subscribe(asset.address, (snap) => listener(toQuote(snap, asset.chain)));
}

export function marketStatus() {
  return { azura: azuraFeed.status(), fallback: hasFallbackProvider() };
}

/** Azura snapshot → the app's Quote shape. `chain` is the app's chain string ('solana'). */
export function toQuote(snap: AzuraSnapshot, chain: string): Quote {
  return {
    chainId: chain.toLowerCase(),
    address: snap.address,
    symbol: snap.symbol ?? undefined,
    name: snap.name ?? undefined,
    imageUrl: snap.imageUrl,
    priceUsd: snap.priceUsd,
    liquidityUsd: snap.liquidityUsd,
    marketCapUsd: snap.marketCapUsd,
    change24hPct: snap.change24hPct,
    dex: snap.dex,
    // The engine prices every fill as platform fee + venue fee; the screens read this to show
    // honest "you receive" estimates.
    feeRate: feeRateFor(PAPER_CONFIG, snap.dex),
    source: 'azura',
    fetchedAt: new Date(snap.fetchedAt).toISOString(),
    ageMs: Date.now() - snap.fetchedAt,
  };
}

/** Exported for the trade engine's validation path; keeps the mapping in one place. */
