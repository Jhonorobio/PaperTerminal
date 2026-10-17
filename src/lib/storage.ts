// Replaces the extension's chrome.storage.local + chrome.storage.onChanged. AsyncStorage has no
// change events, so listeners are kept in a module-level Set and notified in-process — which is
// all the extension ever needed, since every surface lived in one browser profile.

import AsyncStorage from '@react-native-async-storage/async-storage';

import { PAPER_CONFIG } from './engine/rules';
import { DEFAULT_BUY_PRESETS, DEFAULT_SELL_PRESETS, DEFAULT_SERVER_URL } from './config';
import type { Asset, PhotonFilters, PhotonRange, Session, SessionUser } from './types';

export interface Settings {
  serverUrl: string;
  /** Base URL of the feed server (PC: http://192.168.x.x:8787 · prod: Railway URL). */
  serverBase: string;
  buyPresets: number[];
  sellPresets: number[];
  hideDust: boolean;
  priceDisplay: 'price' | 'mcap';
  supportCollapsed: boolean;
  /** Set once the user chooses to browse without signing in, so the welcome screen stays gone. */
  guestOk: boolean;
  /** Slippage tolerance for buys, in percent. Orders that would fill past it revert. */
  slippageBuyPct: number;
  /** Slippage tolerance for sells, in percent. */
  slippageSellPct: number;
  /** Fixed network fee per trade, in USD (priority + tip + base). */
  networkFeeUsd: number;
  /** FOMO feed filters per tab (raw text-field values), so they survive app restarts. The Pump Trend. tab has no filters (fixed top 5). */
  fomoFilters?: { graduated: Record<string, string>; trending: Record<string, string>; pump?: Record<string, string> };
  /** Photon filters per column — persisted in settings, so they survive app restarts. */
  photonFilters?: {
    col1: Partial<Record<keyof PhotonFilters, PhotonRange>>;
    col3: Partial<Record<keyof PhotonFilters, PhotonRange>>;
  };
  /**
   * Mirror of the shared feed proxy as last saved here. The server keeps the real copy
   * (it survives app restarts on its own); this keeps the Settings field populated the
   * moment the screen opens and while the server is unreachable.
   */
  feedProxyUrl?: string;
  feedProxyOn?: boolean;
  /**
   * Mirror of the Track config as last saved here — proxy + filters. A restarted
   * server loses its store; the Track tab re-applies this mirror on load, so the
   * user's setup survives Railway redeploys without re-saving.
   */
  trackConfig?: { enabled: boolean; proxy: string; filters: Record<string, { min?: string; max?: string }> } | null;
  [key: string]: unknown;
}

export const DEFAULTS: Settings = {
  serverUrl: DEFAULT_SERVER_URL,
  serverBase: 'http://localhost:8787',
  buyPresets: DEFAULT_BUY_PRESETS,
  sellPresets: DEFAULT_SELL_PRESETS,
  hideDust: true,
  priceDisplay: 'price',
  supportCollapsed: false,
  guestOk: false,
  slippageBuyPct: PAPER_CONFIG.slippageBuyPct,
  slippageSellPct: PAPER_CONFIG.slippageSellPct,
  networkFeeUsd: PAPER_CONFIG.networkFeeUsd,
  fomoFilters: { graduated: {}, trending: {} },
  photonFilters: { col1: {}, col3: {} },
  feedProxyUrl: '',
  feedProxyOn: false,
  trackConfig: null,
};

const KEYS = { settings: 'settings', session: 'session', recents: 'recentAssets', portfolioVersion: 'portfolioVersion' };

type Changes = { settings?: Settings; session?: Session | null; portfolioVersion?: number; recents?: number };
type Listener = (changes: Changes) => void;

const listeners = new Set<Listener>();

export function onStateChange(cb: Listener) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit(changes: Changes) {
  for (const cb of [...listeners]) {
    try {
      cb(changes);
    } catch (err) {
      console.warn('[Paper Terminal] state listener failed', err);
    }
  }
}

/**
 * The server address comes from the build, never from anything a user can type: pointing the
 * app at someone else's server would hand them your sign-in. `serverUrl` is therefore always
 * re-derived from the bundled default.
 */
function withServerUrl(settings: Settings): Settings {
  return { ...settings, serverUrl: DEFAULT_SERVER_URL.replace(/\/+$/, '') };
}

export async function getSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.settings);
    const stored = raw ? (JSON.parse(raw) as Partial<Settings>) : null;
    return withServerUrl({ ...DEFAULTS, ...(stored ?? {}) });
  } catch {
    return { ...DEFAULTS };
  }
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  try {
    await AsyncStorage.setItem(KEYS.settings, JSON.stringify(next));
  } catch (err) {
    console.warn('[Paper Terminal] could not save settings', err);
  }
  emit({ settings: next });
  return next;
}

export async function getSession(): Promise<Session | null> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.session);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

/** Public session info only (user profile). The token is read by the api layer, never by screens. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getSession();
  return session?.user ?? null;
}

export async function setSession(session: Session): Promise<void> {
  try {
    await AsyncStorage.setItem(KEYS.session, JSON.stringify(session));
  } catch (err) {
    console.warn('[Paper Terminal] could not save session', err);
  }
  emit({ session });
}

export async function clearSession(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEYS.session);
  } catch (err) {
    console.warn('[Paper Terminal] could not clear session', err);
  }
  emit({ session: null });
}

/** Replaces the service worker's bumpPortfolioVersion: tells every screen to refetch. */
export async function bumpPortfolioVersion(): Promise<void> {
  const at = Date.now();
  try {
    await AsyncStorage.setItem(KEYS.portfolioVersion, String(at));
  } catch {
    // an in-memory bump is enough to refresh the screens that are open right now
  }
  emit({ portfolioVersion: at });
}

// ---------- recent assets ----------
// The extension read the active FOMO tab; a standalone app has no tab, so the last tokens the
// user opened are the substitute.

const RECENTS_MAX = 12;

export async function getRecentAssets(): Promise<Asset[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.recents);
    return raw ? (JSON.parse(raw) as Asset[]) : [];
  } catch {
    return [];
  }
}

export async function addRecentAsset(asset: Asset): Promise<Asset[]> {
  const key = `${asset.chain}:${asset.address}`.toLowerCase();
  const previous = await getRecentAssets();
  const next = [
    { ...asset, symbol: asset.symbol ?? previous.find((a) => a.chain === asset.chain && a.address === asset.address)?.symbol ?? null },
    ...previous.filter((a) => `${a.chain}:${a.address}`.toLowerCase() !== key),
  ].slice(0, RECENTS_MAX);
  try {
    await AsyncStorage.setItem(KEYS.recents, JSON.stringify(next));
  } catch (err) {
    console.warn('[Paper Terminal] could not save recents', err);
  }
  emit({ recents: Date.now() });
  return next;
}

/**
 * Replaces the recents list in place — same order, unlike addRecentAsset, which brings its
 * asset to the front. Used by the symbol hydration, which must not reshuffle the user's list.
 */
export async function setRecentAssets(assets: Asset[]): Promise<Asset[]> {
  const next = assets.slice(0, RECENTS_MAX);
  try {
    await AsyncStorage.setItem(KEYS.recents, JSON.stringify(next));
  } catch (err) {
    console.warn('[Paper Terminal] could not save recents', err);
  }
  emit({ recents: Date.now() });
  return next;
}

export async function clearRecentAssets(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEYS.recents);
  } catch {
    // nothing to clear
  }
}
