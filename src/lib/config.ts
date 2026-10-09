// There is no remote server anymore: prices come from the Azura WebSocket feed (src/lib/market)
// and every account lives on the device. `DEFAULT_SERVER_URL` is kept as the label Settings shows.
export const DEFAULT_SERVER_URL = 'local';

/**
 * How old an Azura snapshot may be before it is treated as absent. The trade screen polls every
 * QUOTE_REFRESH_MS, so this sits comfortably above one poll cycle and below PRICE_STALE_MS (30s,
 * when the UI starts warning about stale prices).
 */
export const MARKET_QUOTE_TTL_MS = 12_000;

// Accounts that see admin-only surfaces (the Real P&L card). UI gating only - see admin.ts.
export const ADMIN_EMAILS = ['mateeur9944@gmail.com'];

export const DEFAULT_BUY_PRESETS = [10, 100, 500, 1000];
export const DEFAULT_SELL_PRESETS = [25, 50, 75, 100];

export const QUOTE_REFRESH_MS = 2000;
export const PORTFOLIO_REFRESH_MS = 10000;
export const PRICE_STALE_MS = 30000;

/**
 * Render throttle for the live WSS path. Azura pushes on every fill of the subscribed token —
 * several per second on busy pairs — so pushed quotes are batched into this window before the UI
 * repaints. 300ms reads as instant to the eye and keeps renders sane; the 2s poll stays as the
 * supervisor that notices a dead socket.
 */
export const LIVE_PAINT_MS = 300;

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
