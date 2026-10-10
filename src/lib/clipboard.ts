/**
 * Clipboard → Trade bridge: while the app is in the foreground, a copied token
 * address (FOMO / DexScreener link, `chain:address`, or a bare Solana address)
 * opens Trade on that token — the same deep link a tapped alert uses.
 *
 * Two platform limits shape this:
 *   - Android 10+ / iOS only let an app read the clipboard while it has focus,
 *     so the poll only runs while the app is active (Android 12+ also shows a
 *     system toast for background clipboard reads — avoided entirely here).
 *   - There is no change event on Android, so this polls every ~1.2s; the last
 *     seen string is remembered so one copy fires exactly once.
 */

import * as Clipboard from 'expo-clipboard';
import { AppState } from 'react-native';

import { parseManualAsset } from './asset';
import type { Asset } from './types';

const POLL_MS = 1_200;

export function startClipboardWatch(onAddress: (asset: Asset) => void): () => void {
  let last = '';
  let busy = false;
  let poll: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (poll === null) return;
    clearInterval(poll);
    poll = null;
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const value = await Clipboard.getStringAsync();
      if (!value || value === last) return;
      last = value;
      const asset = parseManualAsset(value);
      if (asset) onAddress(asset);
    } catch {
      // Clipboard unavailable (rare permission states) — retry on the next tick.
    } finally {
      busy = false;
    }
  };

  const start = () => {
    if (poll !== null) return;
    void tick();
    poll = setInterval(tick, POLL_MS);
  };

  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') start();
    else stop();
  });

  start();
  return () => {
    stop();
    appState.remove();
  };
}
