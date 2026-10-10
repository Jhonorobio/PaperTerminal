// Recents saved without a symbol — a clipboard copy or a deep link carries only an address —
// come back nameless in the picker. Ask the paper server what each unknown address is (the
// same quote the Trade screen polls) and fill the symbol in, in place, without reshuffling
// the order the user saw last time.

import { api } from './api';
import type { Asset } from './types';

/** Returns a copy of `assets` with every symbol the server could resolve filled in. */
export async function hydrateRecents(assets: Asset[]): Promise<Asset[]> {
  const out: Asset[] = [];
  for (const asset of assets) {
    if (asset.symbol || !asset.address) {
      out.push(asset);
      continue;
    }
    try {
      const { quote } = await api.quote(asset);
      out.push(quote?.symbol ? { ...asset, symbol: quote.symbol } : asset);
    } catch {
      out.push(asset); // offline or unknown token — the address stub still works
    }
  }
  return out;
}
