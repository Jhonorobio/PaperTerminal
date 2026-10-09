// React replacement for the extension's side-panel `state` object plus its chrome.storage
// listeners. One provider owns the session, server config, account setup flags and portfolio, so
// a trade made on one screen refreshes every other screen — the job `bumpPortfolioVersion` did.

import { ApiError, api, signInWithGoogle as googleFlow, signInDev as devFlow, signOut as signOutFlow } from '@/lib/api';
import { DEFAULTS, getRecentAssets, getSessionUser, getSettings, onStateChange, updateSettings, type Settings } from '@/lib/storage';
import type { Account, Asset, Me, Portfolio, ServerConfig, SessionUser } from '@/lib/types';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type BannerKind = 'ok' | 'err' | 'loss';
export interface Banner {
  kind: BannerKind;
  text: string;
}

interface AppContextValue {
  ready: boolean;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>;
  user: SessionUser | null;
  config: ServerConfig | null;
  serverError: ApiError | null;
  setServerError: (error: ApiError | null) => void;
  account: Account | null;
  needsSetup: boolean;
  needsConsent: boolean;
  portfolio: Portfolio | null;
  recents: Asset[];
  banner: Banner | null;
  flash: (kind: BannerKind, text: string, ms?: number) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  loadConfig: () => Promise<void>;
  loadAccount: () => Promise<void>;
  loadPortfolio: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signInDev: (email: string, name?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [serverError, setServerError] = useState<ApiError | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [recents, setRecents] = useState<Asset[]>([]);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState(false);

  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userRef = useRef<SessionUser | null>(null);
  // Callbacks read the session through this ref so they never capture a stale user; it is written
  // from an effect rather than during render.
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const flash = useCallback((kind: BannerKind, text: string, ms = 6000) => {
    setBanner({ kind, text });
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setBanner((b) => (b?.text === text ? null : b)), ms);
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await api.config());
      setServerError(null);
    } catch (err) {
      setServerError(err instanceof ApiError ? err : null);
    }
  }, []);

  const loadAccount = useCallback(async () => {
    if (!userRef.current) return;
    try {
      const me: Me = await api.me();
      setAccount(me.account ?? null);
      setNeedsSetup(me.needsSetup === true);
      setNeedsConsent(me.needsConsent === true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SERVER_UNREACHABLE') setServerError(err);
    }
  }, []);

  const loadPortfolio = useCallback(async () => {
    if (!userRef.current) return;
    try {
      const p = await api.portfolio();
      setPortfolio(p);
      if (p.account) setAccount(p.account);
      setNeedsSetup(false);
      setServerError(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ACCOUNT_SETUP_REQUIRED') {
        setNeedsSetup(true);
        setPortfolio(null);
      } else if (err instanceof ApiError && err.code === 'SERVER_UNREACHABLE') {
        setServerError(err);
      }
      // otherwise keep last known values, as the side panel did
    }
  }, []);

  // Bootstrap + the chrome.storage.onChanged listener, replaced by in-process events.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [s, r] = await Promise.all([getSettings(), getRecentAssets()]);
      if (cancelled) return;
      setSettings(s);
      setRecents(r);
      const session = await getSessionUser();
      if (cancelled) return;
      setUser(session);
      userRef.current = session;
      await loadConfig();
      if (session) await loadAccount();
      if (!cancelled) setReady(true);
    })();

    const unsubscribe = onStateChange((changes) => {
      if (changes.settings) setSettings(changes.settings);
      if (changes.recents) void getRecentAssets().then(setRecents);
      if (changes.session !== undefined) {
        const next = changes.session?.user ?? null;
        setUser(next);
        userRef.current = next;
        if (!next) {
          setAccount(null);
          setPortfolio(null);
          setNeedsSetup(false);
          setNeedsConsent(false);
        } else {
          void loadAccount();
          void loadPortfolio();
        }
      } else if (changes.portfolioVersion) {
        void loadPortfolio();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      if (bannerTimer.current) clearTimeout(bannerTimer.current);
    };
  }, [loadAccount, loadConfig, loadPortfolio]);

  // The side panel refreshed the portfolio every 15s while visible; a screen stays visible here.
  useEffect(() => {
    if (!user || needsSetup || needsConsent) return;
    const id = setInterval(() => {
      void loadPortfolio();
    }, 15000);
    return () => clearInterval(id);
  }, [user, needsSetup, needsConsent, loadPortfolio]);

  const signInWithGoogle = useCallback(async () => {
    setBusy(true);
    try {
      await googleFlow();
    } finally {
      setBusy(false);
    }
  }, []);

  const signInDev = useCallback(async (email: string, name?: string) => {
    setBusy(true);
    try {
      await devFlow(email, name);
    } finally {
      setBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await signOutFlow();
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'Sign out failed.');
    } finally {
      setBusy(false);
    }
  }, [flash]);

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      settings,
      updateSettings,
      user,
      config,
      serverError,
      setServerError,
      account,
      needsSetup,
      needsConsent,
      portfolio,
      recents,
      banner,
      flash,
      busy,
      setBusy,
      loadConfig,
      loadAccount,
      loadPortfolio,
      signInWithGoogle,
      signInDev,
      signOut,
    }),
    [
      ready,
      settings,
      user,
      config,
      serverError,
      setServerError,
      account,
      needsSetup,
      needsConsent,
      portfolio,
      recents,
      banner,
      flash,
      busy,
      loadConfig,
      loadAccount,
      loadPortfolio,
      signInWithGoogle,
      signInDev,
      signOut,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
