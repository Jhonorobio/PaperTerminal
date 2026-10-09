/**
 * FOMO (fomo.family) authentication — Privy customer access tokens, ported from
 * `server con APIS/src/services/fomo-auth.js`.
 * The FOMO WebSocket challenges every new connection and expects a Privy customer
 * access token in `challengeResponse`. Those tokens live 1h; a long-lived refresh
 * token mints new ones with no user session:
 *
 *   POST https://auth.privy.io/api/v1/sessions
 *   headers: privy-app-id, origin: https://fomo.family
 *   body: { refresh_token }
 *   → { token, refresh_token?, session_update_action }
 *
 * The refresh token comes from `EXPO_PUBLIC_FOMO_REFRESH_TOKEN` (.env). It lasts
 * until you log out of fomo.family — then paste a fresh one.
 */

import { Platform } from 'react-native';

const PRIVY_APP_ID = 'cm6h485o300n3zj9yl6vpedq7'; // FOMO's Privy app (jwt `aud`)
const SESSIONS_URL = 'https://auth.privy.io/api/v1/sessions';
const REFRESH_TIMEOUT_MS = 15_000;
/** Refresh the access token when less than this much of its 1h life remains. */
const MIN_REMAINING_MS = 120_000;

let accessToken: string | null = null;
let accessExpMs = 0;
let inflight: Promise<string> | null = null;

export function getRefreshToken(): string | null {
  return process.env.EXPO_PUBLIC_FOMO_REFRESH_TOKEN || null;
}

export function hasCredentials(): boolean {
  return Boolean(getRefreshToken());
}

function decodeExp(jwt: string): number {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return Number(payload.exp) * 1000 || 0;
  } catch {
    return 0;
  }
}

/**
 * A Privy customer access token valid for at least the next ~2 minutes.
 * Single-flight: concurrent callers share one in-flight refresh.
 */
export function getAccessToken({ force = false }: { force?: boolean } = {}): Promise<string> {
  if (!force && accessToken && Date.now() < accessExpMs - MIN_REMAINING_MS) {
    return Promise.resolve(accessToken);
  }
  if (inflight) return inflight;

  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    return Promise.reject(new Error('FOMO: no refresh token — set EXPO_PUBLIC_FOMO_REFRESH_TOKEN in .env'));
  }

  inflight = (async () => {
    try {
      const res = await fetch(SESSIONS_URL, {
        method: 'POST',
        headers: {
          'privy-app-id': PRIVY_APP_ID,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          origin: 'https://fomo.family',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => null)) as { token?: string; refresh_token?: string } | null;
      if (!res.ok || !body?.token) {
        // Privy validates the request origin: the browser sends `localhost` and rejects it (403).
        // React Native native sends none, so the same call works on device.
        if (res.status === 403 && Platform.OS === 'web') {
          throw new Error('FOMO no está disponible en el navegador: Privy bloquea orígenes que no son fomo.family. Abrilo en Expo Go o una dev build.');
        }
        throw new Error(`FOMO refresh failed: HTTP ${res.status}`);
      }
      accessToken = body.token;
      accessExpMs = decodeExp(body.token) || Date.now() + 3_600_000;
      // Privy may rotate the refresh token someday; env wins over any stored copy,
      // so a rotation simply means "paste the new one in .env".
      return accessToken;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Drop the cached token — the next call mints a fresh one (after an auth failure). */
export function invalidateAccessToken(): void {
  accessToken = null;
  accessExpMs = 0;
}

export function fomoAuthStatus() {
  return {
    hasRefreshToken: hasCredentials(),
    hasCachedToken: Boolean(accessToken),
    tokenExpiresInSeconds: accessExpMs ? Math.max(0, Math.round((accessExpMs - Date.now()) / 1000)) : null,
  };
}
