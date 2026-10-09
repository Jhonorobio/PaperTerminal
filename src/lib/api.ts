/**
 * API client. Ported from `1.0.1_0/src/services/api.js` + the `api`/`auth` handlers of
 * `1.0.1_0/src/background/service-worker.js`.
 * The background worker is gone, so this module does its job directly:
 *   - it attaches `Authorization: Bearer <sessionToken>` (the worker's `request()` did that);
 *   - it keeps the session in `storage.ts` (was `chrome.storage.local`);
 *   - it bumps the portfolio version after a mutation (was `bumpPortfolioVersion`);
 *   - Google sign-in runs the OAuth flow in a system browser (was `chrome.identity`), but the
 *     server contract is unchanged: it receives `{ accessToken }` and answers `{ sessionToken, user }`.
 */
import { AuthRequest, exchangeCodeAsync, makeRedirectUri, ResponseType } from 'expo-auth-session';
import { Platform } from 'react-native';

import { DEFAULT_SERVER_URL } from './config';
import { bumpPortfolioVersion, clearSession, getSession, setSession } from './storage';
import type {
  Account,
  Asset,
  ClosedTrade,
  ExportedFile,
  Me,
  Portfolio,
  Position,
  Quote,
  ServerConfig,
  SessionUser,
  Trade,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

const SERVER_URL = DEFAULT_SERVER_URL.replace(/\/+$/, '');

/**
 * The worker had no timeout at all; 15s was stricter than reality, because Railway sleeps when
 * idle and the first request against a cold instance takes 20-30s. That turned the very first
 * call into a guaranteed failure, so this now covers a full cold start.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** Idempotency key for trades, so a retried tap cannot double-fill. */
export function newClientRequestId(): string {
  return `pt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

type Method = 'GET' | 'POST';

async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  opts: { raw?: boolean; token?: string } = {},
): Promise<T> {
  const session = await getSession();
  // `opts.token` checks a candidate token against the server without touching the stored session.
  const token = opts.token ?? session?.token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(SERVER_URL + path, {
        method,
        headers,
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const detail = err instanceof Error ? ` (${err.message})` : '';
    throw new ApiError(0, 'SERVER_UNREACHABLE', `Paper server is unreachable${detail}.`, err);
  }

  if (opts.raw) {
    if (!response.ok) throw new ApiError(response.status, 'HTTP_ERROR', `Request failed (${response.status}).`);
    return (await response.text()) as T;
  }

  const data = (await response.json().catch(() => null)) as (ErrorBody & Record<string, unknown>) | null;
  if (!response.ok) {
    // Only drop the session this request actually used; a newer sign-in survives a stale 401.
    if (response.status === 401 && session) {
      const current = await getSession();
      if (current?.token === session.token) await clearSession();
    }
    const err = data?.error ?? {};
    throw new ApiError(
      response.status,
      err.code || 'HTTP_ERROR',
      err.message || `Request failed (${response.status}).`,
      err.details,
    );
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return s ? `?${s}` : '';
};

// Paths the extension's ALLOWED list let through the bridge. Same set here, for the same reason.
const MUTATIONS = /^\/api\/(trades|positions\/close|account\/start|account\/reset|account\/delete)$/;

export const api = {
  config: () => request<ServerConfig>('GET', '/api/config'),
  health: () => request<{ ok?: boolean }>('GET', '/api/health'),
  me: () => request<Me>('GET', '/api/me'),
  /** Checks a pasted bearer token against the server; leaves whatever session is stored alone. */
  verifyToken: (token: string) => request<Me>('GET', '/api/me', undefined, { token }),
  quote: (asset: Asset) => request<{ quote: Quote }>('GET', `/api/quote${qs({ chain: asset.chain, address: asset.address })}`),
  tokenLogo: (chain: string, address: string) => request<{ dataUrl?: string }>('GET', `/api/token-logo${qs({ chain, address })}`),
  priceHistory: (chain: string, address: string, from?: number, to?: number) =>
    request<{ points: unknown[] }>('GET', `/api/price-history${qs({ chain, address, from, to })}`),
  assetState: (asset: Asset) =>
    request<{ quote: Quote; position: Position | null }>('GET', `/api/asset-state${qs({ chain: asset.chain, address: asset.address })}`),
  portfolio: () => request<Portfolio>('GET', `/api/portfolio${qs({ tzOffset: new Date().getTimezoneOffset() })}`),
  trades: (filters: Record<string, string | number | undefined> = {}) => request<{ trades: Trade[] }>('GET', `/api/trades${qs(filters)}`),
  closedTrades: (filters: Record<string, string | number | undefined> = {}) => request<{ closedTrades: ClosedTrade[] }>('GET', `/api/closed-trades${qs(filters)}`),
  trade: (body: Record<string, unknown>) => call('POST', '/api/trades', body) as Promise<TradeResult>,
  closePosition: (body: Record<string, unknown>) => call('POST', '/api/positions/close', body) as Promise<TradeResult>,
  consent: (body: Record<string, unknown>) => call('POST', '/api/consent', body),
  deleteAccount: async () => {
    const data = await call('POST', '/api/account/delete');
    // Deleting the account kills the session with it; drop it so the UI signs out cleanly.
    await clearSession();
    return data;
  },
  updateProfile: async (body: { displayName?: string; photoUrl?: string | null }) => {
    const data = await call('POST', '/api/profile', body) as { user?: SessionUser };
    // Keep the stored session in step, so every surface shows the new username or picture.
    if (data?.user) {
      const session = await getSession();
      if (session) await setSession({ ...session, user: data.user });
    }
    return data;
  },
  startAccount: (startingBalance: number) => call('POST', '/api/account/start', { startingBalance }) as Promise<{ account: Account }>,
  resetAccount: (startingBalance: number) => call('POST', '/api/account/reset', { startingBalance }) as Promise<{ account: Account }>,
  export: (format: 'json' | 'csv') => request<ExportedFile>('GET', `/api/export?format=${format === 'csv' ? 'csv' : 'json'}`),
};

/** POSTs a mutation and tells every screen the portfolio changed — the worker's bump. */
async function call<T = unknown>(method: Method, path: string, body?: unknown): Promise<T> {
  const data = await request<T>(method, path, body);
  if (MUTATIONS.test(path)) await bumpPortfolioVersion();
  return data;
}

export interface TradeResult {
  position: Position | null;
  trade: Trade;
}

// ---------- auth ----------

/**
 * True when this build carries a Google client id. The extension hardcodes its Chrome-extension
 * id; here it comes from `EXPO_PUBLIC_GOOGLE_*_CLIENT_ID` in `.env`, so an unconfigured build
 * disables sign-in with an explanatory message instead of failing mid-flow.
 *
 * This deliberately ignores `/api/config`'s `googleClientId`: that one belongs to the extension's
 * Google project and only authorises `https://<ext-id>.chromiumapp.org/` as a redirect, so Google
 * would reject any other origin with `redirect_uri_mismatch`. A standalone app must use an id from
 * its own project.
 */
export const authInfo = {
  googleConfigured: () => Boolean(googleClientId()),
};

/**
 * Client id for this platform. Google matches redirect URIs per client, so iOS and Android each
 * need their own; `web` is what Expo Go uses (its redirect is an `exp://` URL).
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
 * Sign in with Google. Same shape as the worker's `runGoogleSignIn`: open the consent screen,
 * take the resulting access token and hand it to the server, which answers with the session.
 *
 * The extension used the implicit flow because a Chrome-extension redirect URI cannot receive a
 * code exchange; here the flow runs in a system browser, so it uses the authorization code flow
 * with PKCE (what Google recommends on native) and sends the *access token* it returns — which is
 * exactly what `/api/auth/google` expects, so the server is untouched.
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

  const data = await request<{ sessionToken: string; user: SessionUser }>('POST', '/api/auth/google', { accessToken: tokens.accessToken });
  await setSession({ token: data.sessionToken, user: data.user });
  await bumpPortfolioVersion();
  return { user: data.user };
}

/** Local developer sign-in, only offered when the server answers `devAuth: true`. */
export async function signInDev(email: string, name?: string): Promise<{ user: SessionUser }> {
  const data = await request<{ sessionToken: string; user: SessionUser }>('POST', '/api/auth/dev', { email, name });
  await setSession({ token: data.sessionToken, user: data.user });
  await bumpPortfolioVersion();
  return { user: data.user };
}

export async function signOut(): Promise<void> {
  try {
    await request('POST', '/api/auth/logout');
  } catch {
    // signing out locally is enough
  }
  await clearSession();
}
