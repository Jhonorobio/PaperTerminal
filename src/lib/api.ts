/**
 * API client — local implementation. The app used to talk to a hosted paper server over HTTP with
 * a bearer token; it now keeps the user, the paper account and every fill on the device. The
 * exported surface is byte-for-byte the same contract the screens were built against, so no screen
 * changed: `api.*` methods, `ApiError` codes, `TradeResult`, the auth flows and
 * `newClientRequestId` all behave as before.
 *
 * Where each piece lives now:
 *   prices ....... `./market` (Azura WSS; a fallback provider can be registered later)
 *   economics ... `./engine` (pure: fills, portfolio, trading style)
 *   persistence . `./store`  (AsyncStorage record: user, account, positions, trades, closed trades)
 */

import { AuthRequest, exchangeCodeAsync, makeRedirectUri, ResponseType } from 'expo-auth-session';
import { Platform } from 'react-native';

import { ApiError } from './errors';
import { bumpPortfolioVersion, clearSession } from './storage';
import { store } from './store';
import { fetchQuote } from './market';
import type { Asset, ExportedFile, Position, ServerConfig, SessionUser, Trade } from './types';

export { ApiError } from './errors';
export type { ErrorBody } from './errors';

export interface TradeResult {
  position: Position | null;
  trade: Trade;
}

/** Idempotency key for trades, so a retried tap cannot double-fill. */
export function newClientRequestId(): string {
  return `pt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export const api = {
  config: (): Promise<ServerConfig> => Promise.resolve(store.config()),
  health: () => Promise.resolve({ ok: true }),
  me: () => store.me(),
  /** Nothing to verify against — a local build has no server-side token check. */
  verifyToken: (_token: string) => store.me(),
  quote: async (asset: Asset) => ({ quote: await fetchQuote(asset) }),
  tokenLogo: async (chain: string, address: string) => ({
    dataUrl: (await store.logo({ chain, address, symbol: null })) ?? undefined,
  }),
  /**
   * Historical price series. Azura's feed is live-only (no OHLC), so this returns an empty series.
   * The chart screen is not wired to it in this build; register a fallback market provider that
   * serves history and this is where it plugs in.
   */
  priceHistory: async (chain: string, address: string, from?: number, to?: number) => ({ points: [] as unknown[] }),
  assetState: (asset: Asset) => store.assetState(asset),
  portfolio: () => store.portfolio(new Date().getTimezoneOffset()),
  trades: async (filters: Record<string, string | number | undefined> = {}) => ({
    trades: await store.trades((filters.side as 'BUY' | 'SELL' | '' | undefined) ?? ''),
  }),
  closedTrades: async () => ({ closedTrades: await store.closedTrades() }),
  trade: (body: Record<string, unknown>) =>
    store.executeOrder({
      chain: String(body.chain),
      address: String(body.address),
      side: body.side === 'SELL' ? 'SELL' : 'BUY',
      clientRequestId: String(body.clientRequestId ?? newClientRequestId()),
      amountUsd: body.amountUsd != null ? Number(body.amountUsd) : undefined,
      percent: body.percent != null ? Number(body.percent) : undefined,
    }) as Promise<TradeResult>,
  closePosition: (body: Record<string, unknown>) =>
    store.closePosition(String(body.chain), String(body.address), String(body.clientRequestId ?? newClientRequestId())) as Promise<TradeResult>,
  consent: (body: Record<string, unknown>) =>
    store.consent({
      acceptedTerms: Boolean(body.acceptedTerms),
      confirmedAge: Boolean(body.confirmedAge),
    }),
  deleteAccount: async () => {
    await store.deleteAccount();
    // Deleting the account kills the session with it; the store already cleared it.
  },
  updateProfile: async (body: { displayName?: string; photoUrl?: string | null }) => ({
    user: await store.updateProfile(body),
  }),
  startAccount: async (startingBalance: number) => ({ account: await store.startAccount(startingBalance) }),
  resetAccount: async (startingBalance: number) => ({ account: await store.resetAccount(startingBalance) }),
  export: (format: 'json' | 'csv') => exportFile(format),
};

// ---------- export ----------

const pad = (n: number) => String(n).padStart(2, '0');
const fileStamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const TRADE_CSV_COLUMNS = [
  'id',
  'timestamp',
  'side',
  'symbol',
  'chainId',
  'address',
  'quantity',
  'executionPrice',
  'marketPrice',
  'requestedValue',
  'fee',
  'realizedPnl',
  'cashAfter',
] as const;

async function exportFile(format: 'json' | 'csv'): Promise<ExportedFile> {
  const { account, trades, closed } = await store.exportData();

  if (format === 'csv') {
    const rows = [
      TRADE_CSV_COLUMNS.join(','),
      ...trades.map((t) =>
        TRADE_CSV_COLUMNS.map((c) =>
          csvCell({
            id: t.id,
            timestamp: t.timestamp,
            side: t.side,
            symbol: t.symbol ?? '',
            chainId: t.chainId ?? '',
            address: t.address ?? '',
            quantity: t.quantity,
            executionPrice: t.executionPrice,
            marketPrice: t.marketPrice ?? '',
            requestedValue: t.requestedValue ?? '',
            fee: t.fee ?? 0,
            realizedPnl: t.realizedPnl ?? '',
            cashAfter: t.cashAfter ?? '',
          }[c]),
        ).join(','),
      ),
    ];
    return {
      text: rows.join('\n'),
      contentType: 'text/csv',
      filename: `paper-terminal-trades-${fileStamp()}.csv`,
    };
  }

  return {
    text: JSON.stringify({ account, trades, closedTrades: closed, exportedAt: new Date().toISOString() }, null, 2),
    contentType: 'application/json',
    filename: `paper-terminal-export-${fileStamp()}.json`,
  };
}

// ---------- auth ----------

/**
 * True when this build carries a Google client id (from `EXPO_PUBLIC_GOOGLE_*_CLIENT_ID`). Without
 * one, the developer sign-in card is offered instead.
 */
export const authInfo = {
  googleConfigured: () => Boolean(googleClientId()),
};

/**
 * Client id for this platform. Google matches redirect URIs per client, so iOS and Android each
 * need their own; `web` is what Expo Go uses.
 */
function googleClientId(): string {
  if (Platform.OS === 'ios' && process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID) {
    return process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  }
  if (Platform.OS === 'android' && process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID) {
    return process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
  }
  return process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';
}

const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

/**
 * Sign in with Google. The flow is unchanged from the hosted build (system browser → authorization
 * code + PKCE); the difference is the last step: instead of handing the access token to a server,
 * the app reads the profile straight from Google's userinfo endpoint. Identity never leaves the
 * device, and if userinfo is unreachable the flow fails with a clear message instead of silently
 * creating a blank account.
 */
export async function signInWithGoogle(): Promise<{ user: SessionUser }> {
  const clientId = googleClientId();
  if (!clientId) {
    throw new ApiError(501, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured yet. Set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID in .env.');
  }

  const redirectUri = makeRedirectUri({ path: 'auth' });
  const authRequest = new AuthRequest({
    clientId,
    redirectUri,
    usePKCE: true,
    responseType: ResponseType.Code,
    scopes: ['openid', 'email', 'profile'],
    extraParams: { prompt: 'select_account' },
  });

  let code: string | null = null;
  try {
    const result = await authRequest.promptAsync(GOOGLE_DISCOVERY);
    if (result.type === 'success') code = result.params.code ?? null;
    else if (result.type === 'dismiss' || result.type === 'cancel') throw new ApiError(0, 'AUTH_CANCELLED', 'Google sign-in was cancelled.');
    else if (result.type === 'error') throw new ApiError(0, 'AUTH_FAILED', result.error?.message || 'Google sign-in failed.');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, 'AUTH_FAILED', `Google sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!code) throw new ApiError(0, 'AUTH_FAILED', 'Google did not return an authorization code.');

  let tokens;
  try {
    tokens = await exchangeCodeAsync(
      { clientId, code, redirectUri, extraParams: { codeVerifier: authRequest.codeVerifier ?? '' } },
      GOOGLE_DISCOVERY,
    );
  } catch (err) {
    throw new ApiError(0, 'AUTH_FAILED', `Google sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!tokens.accessToken) throw new ApiError(0, 'AUTH_FAILED', 'Google did not return an access token.');

  const user = await fetchGoogleProfile(tokens.accessToken);
  const signedIn = await store.googleSignIn(user);
  await bumpPortfolioVersion();
  return { user: signedIn };
}

/** Reads the signed-in profile from Google's userinfo endpoint (no backend in the middle). */
async function fetchGoogleProfile(accessToken: string): Promise<SessionUser> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`userinfo HTTP ${res.status}`);
    const j = (await res.json()) as { email?: string; name?: string; picture?: string };
    if (!j.email) throw new Error('userinfo returned no email');
    return { email: j.email, displayName: j.name ?? undefined, photoUrl: j.picture ?? null };
  } catch (err) {
    throw new ApiError(0, 'AUTH_FAILED', `Could not read your Google profile: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Local developer sign-in. Always offered (`config.devAuth`) since there is no server to guard. */
export async function signInDev(email: string, name?: string): Promise<{ user: SessionUser }> {
  if (!email.trim()) throw new ApiError(400, 'INVALID_EMAIL', 'Enter an email to sign in.');
  const user = await store.devSignIn(email, name);
  await bumpPortfolioVersion();
  return { user };
}

export async function signOut(): Promise<void> {
  await clearSession();
}

