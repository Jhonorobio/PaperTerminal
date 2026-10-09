// Ported from the extension's integrations/target-terminal/adapter.js. These two parsers are the
// piece that survives the move to a standalone app: in the extension they read the FOMO tab's URL,
// here they read whatever the user pastes into the token field.

import type { Asset } from './types';

export const TOKEN_PATH = /^\/tokens\/([a-z0-9-]+)\/([A-Za-z0-9._-]{20,})\/?$/;
export const LEGACY_TOKEN_PATH = /^\/token\/?$/;

/** FOMO's numeric network ids (used by legacy ?chainId= links). */
const NETWORK_SLUGS: Record<string, string> = {
  1399811149: 'solana',
  8453: 'base',
  56: 'bsc',
  1: 'ethereum',
  143: 'monad',
  5042: 'arc',
  4663: 'robinhood',
};

/** Pure URL parser, so it can be reused outside the DOM (deep links, paste, recents). */
export function parseAssetFromUrl(href: string): Asset | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname !== 'fomo.family' && !url.hostname.endsWith('.fomo.family')) return null;

  const match = TOKEN_PATH.exec(url.pathname);
  if (match) return { chain: match[1].toLowerCase(), address: match[2], symbol: null, source: 'url' };

  if (LEGACY_TOKEN_PATH.test(url.pathname)) {
    const address = url.searchParams.get('address') || url.searchParams.get('tokenAddress');
    const chain = NETWORK_SLUGS[url.searchParams.get('chainId') ?? ''] || url.searchParams.get('chain');
    if (address && chain) return { chain, address, symbol: null, source: 'url' };
  }
  return null;
}

/** Chains a bare pasted address is assumed to live on when it carries no `chain:` prefix. */
export const DEFAULT_CHAIN = 'solana';

/**
 * Solana addresses are base58 over 32 bytes — 32 to 44 chars, and the alphabet excludes `0`, so
 * they can never be confused with an `0x…` EVM contract. This is what lets a bare paste default.
 */
const BARE_SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Accepts a FOMO token URL, a DexScreener URL, "chain:address", or a bare Solana address.
 * Used by the manual "Enter asset" fallback — the app's only way to pick a token, since there is
 * no FOMO tab to read and the paper server exposes no search endpoint.
 */
export function parseManualAsset(input: string): Asset | null {
  const value = String(input ?? '').trim();
  const fromFomo = parseAssetFromUrl(value);
  if (fromFomo) return { ...fromFomo, source: 'manual' };
  const dex = /dexscreener\.com\/([a-z0-9-]+)\/([A-Za-z0-9]{20,66})/i.exec(value);
  if (dex) return { chain: dex[1].toLowerCase(), address: dex[2], symbol: null, source: 'manual' };
  const pair = /^([a-z0-9-]+):([A-Za-z0-9._-]{20,})$/i.exec(value);
  if (pair) return { chain: pair[1].toLowerCase(), address: pair[2], symbol: null, source: 'manual' };

  // A bare address with no prefix. Base58 over 32 bytes is unambiguous — it is Solana's alone —
  // whereas `0x…` is shared by every EVM chain and has to keep an explicit `chain:`.
  if (BARE_SOLANA.test(value)) return { chain: DEFAULT_CHAIN, address: value, symbol: null, source: 'manual' };
  return null;
}

export const tokenHref = (chainId?: string, address?: string) =>
  `https://fomo.family/tokens/${encodeURIComponent(chainId ?? '')}/${encodeURIComponent(address ?? '')}`;
