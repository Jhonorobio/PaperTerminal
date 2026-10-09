// Extension-side defaults. Paper account economics (starting balance, fees) live on the server.
// The hosted paper server. Settings can point at http://localhost:8787 for local development.
export const DEFAULT_SERVER_URL = 'https://paper-terminal-production.up.railway.app';

// Accounts that see admin-only surfaces (the Real P&L card). UI gating only - see admin.ts.
export const ADMIN_EMAILS = ['mateeur9944@gmail.com'];

export const DEFAULT_BUY_PRESETS = [10, 100, 500, 1000];
export const DEFAULT_SELL_PRESETS = [25, 50, 75, 100];

export const QUOTE_REFRESH_MS = 2000;
export const PORTFOLIO_REFRESH_MS = 10000;
export const PRICE_STALE_MS = 30000;

export const TARGET_TERMINAL = {
  name: 'FOMO',
  origin: 'https://fomo.family',
};

/** Tokens below this value are dust: hidden behind a toggle in the positions list. */
export const DUST_USD = 3;

/** Closed trades needed for a confident style read. */
export const STYLE_SAMPLE = 5;

export const LOW_LIQUIDITY_USD = 10000;

/**
 * Google OAuth client IDs for this app, one per platform. Empty until configured — sign-in stays
 * disabled and the button explains what to fill in. These belong to *this* app's Google Cloud
 * project, not to the extension's, because Google matches redirect URIs exactly per client.
 */
export const GOOGLE_CLIENT_IDS = {
  ios: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '',
  android: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '',
  web: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '',
};

export const googleConfigured = () => Boolean(GOOGLE_CLIENT_IDS.ios || GOOGLE_CLIENT_IDS.android || GOOGLE_CLIENT_IDS.web);
