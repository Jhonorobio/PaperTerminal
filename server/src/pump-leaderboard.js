/**
 * Global PnL leaderboard de pump.fun — top 100 daily / weekly, refrescado cada
 * 15 minutos.
 *
 * Es la fuente para decidir si un holder ≥$100 está en el top 50 de 1D o 1W:
 * el endpoint devuelve las 100 entradas de cada período con `rank`,
 * `walletAddress` y `userId`, y el match contra los holders de `mint-positions`
 * es local (por wallet Y por cuenta: una wallet secundaria comparte userId).
 *
 * Por qué cada 15 min: el board se mueve, pero la membresía cambia lento; 2
 * requests cada 15 min (daily + weekly, ~120 KB c/u) mantienen el dato fresco
 * sin sumar carga al camino del tracker. El endpoint responde directo (200, sin
 * Cloudflare), así que no necesita CycleTLS.
 *
 * Si una pasada falla, se conserva el board anterior; si nunca hubo uno,
 * `getLeaderboard()` devuelve null y los llamadores reintentan en el próximo
 * barrido (no se marca "topChecked" con datos ausentes).
 */
const REFRESH_MS = 15 * 60_000;
const TIMEOUT_MS = 8_000;
const PERIODS = ['daily', 'weekly'];
const HEADERS = {
  accept: 'application/json, text/plain, */*',
  origin: 'https://pump.fun',
  referer: 'https://pump.fun/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const URL_OF = (period) => `https://frontend-api-v3.pump.fun/pnl-leaderboard?period=${period}`;

let state = null;
let timer = null;
let inflight = null;

function indexEntries(entries) {
  const byWallet = new Map();
  const byUser = new Map();
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.walletAddress) byWallet.set(entry.walletAddress, entry);
    if (entry.userId) byUser.set(entry.userId, entry);
  }
  return { byWallet, byUser };
}

async function fetchPeriod(period) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_OF(period), { headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json?.entries) ? json.entries : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Una pasada: daily + weekly. Conserva el período que falló si el otro vino. */
export async function refreshLeaderboard() {
  if (inflight) return inflight;
  inflight = (async () => {
    const [daily, weekly] = await Promise.all([fetchPeriod('daily'), fetchPeriod('weekly')]);
    if (!daily && !weekly) return; // sin dato nuevo: queda el board anterior
    const dailyEntries = daily ?? state?.dailyEntries ?? [];
    const weeklyEntries = weekly ?? state?.weeklyEntries ?? [];
    const d = indexEntries(dailyEntries);
    const w = indexEntries(weeklyEntries);
    state = {
      at: Date.now(),
      dailyEntries,
      weeklyEntries,
      dailyByWallet: d.byWallet,
      dailyByUser: d.byUser,
      weeklyByWallet: w.byWallet,
      weeklyByUser: w.byUser,
    };
    console.log(`[leaderboard] refreshed · daily ${dailyEntries.length} · weekly ${weeklyEntries.length}`);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Board vigente o null si todavía no hubo una pasada completa. */
export function getLeaderboard() {
  return state;
}

export function startLeaderboard() {
  if (timer) return;
  void refreshLeaderboard();
  timer = setInterval(() => void refreshLeaderboard(), REFRESH_MS);
  timer.unref?.();
}

export function stopLeaderboard() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Períodos que expone el board (para tests / diagnóstico). */
export const LEADERBOARD_PERIODS = PERIODS;
