/**
 * Token tracker — a SECOND Photon Graduated poller that snapshots the tokens you
 * care about, once a minute, so a migration can be analysed after the fact.
 *
 * Lifecycle:
 *   enter   — a token shows up in the Graduated column after PHOTON filters it
 *             with the track's OWN filter set (track_config; independent from the
 *             app column filters). The filters travel as query params — the exact
 *             mechanism the app's Photon screen uses — so "pasa el filtro"
 *             means the same thing on both screens.
 *   capture — while it stays visible in the column: one snapshot per minute with
 *             top holders %, holders, snipers %, snipers, bundle %, bundle count,
 *             buys, sells, market cap, volume and tp holders ("bots"). Además,
 *             cada wallet con callout ≥$100 que APARECE después de la línea base
 *             deja su fila (el minuto + el PnL de su portfolio 1d/1w) — ver
 *             "Entradas CAL100" más abajo.
 *   pause   — it dropped out of the column: capture stops, the data stays; if it
 *             reappears capture resumes, over and over.
 *   cut     — 50 snapshots reached: the track is over for that token (its data is
 *             kept forever, it is never sampled again).
 *
 * The set is capped at 500 tokens: a new arrival evicts the oldest by
 * first-tracked time, so history stays bounded while always covering the newest
 * migrations.
 *
 * Hard gate: the poller idles until the track's OWN proxy (configured in the
 * app, never the shared FOMO/Photon one) is saved, and the track's filter set
 * has at least one field — no proxy, no entries; no filters, no entries.
 *
 * Own CycleTLS client + own backoff, so the app feed's rate limit and transport
 * never interact with tracking. Egress ONLY rides the track's own proxy — a dead
 * proxy means failed ticks and retries, never a direct fallback.
 */
import initCycleTLS from 'cycletls';

import { buildQuery, HEADERS, SEARCH_URL, sanitizeColumnFilters } from './photon.js';
import { getAccessToken } from './fomo.js';
import { getEffectiveProxy } from './proxy-config.js';
import { emitTrackEntry, TRACK_ENTRY_CATEGORIES, emitTrackCal100Pos } from './notify.js';
import { broadcast, getSubscriptions, registerTopicProvider } from './ws.js';
import { normalizeProxy } from './proxy-config.js';
import { trackConfig, trackTokens } from './stores.js';

// The column is pulled as fast as Photon sustains (same cadence as the FOMO
// watcher) so a token is caught the second it appears; the per-token snapshot
// stays at one per minute — that cadence is the product requirement.
const PULL_MS = 1300;
const SNAPSHOT_MS = 60_000;
// A miss must repeat before a token is paused: at 1.3s pulls a single
// partial/reshuffled column response would otherwise flip the whole list.
const TRACK_MISS_GRACE = 2;
// Terminal, not a pause forever: 30 continuous minutes out of the column end the
// run ("Cortado") even if the token never reached the 50-snapshot cap. Reappearing
// after the cut stays cut — same rule as hitting the cap.
const TRACK_PAUSE_CUT_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const PROXY_TEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_BACKOFF_MS = 45_000;
// Fails are usually a dead proxy answering in <1s — don't hammer it 46x/min.
const ERROR_BACKOFF_MS = 15_000;
export const TRACK_SNAPSHOT_MAX = 50;
export const TRACK_TOKENS_MAX = 500;
// Ventana de reintento de las alertas de ENTRADA del Track (min 1-3): una fuente
// extra que vino null en el snapshot de entrada se vuelve a evaluar el minuto
// 2-3. Pasada la ventana ya no se alerta (la decisión es de entrada; ver
// TRACK_ENTRY_CATEGORIES en notify.js).
const TRACK_ALERT_WINDOW = 3;
// Buy-signal entry profile — the measured winners-vs-traps separators (see
// trackBuySignal): winners enter with few bots, a small crowd and no snipers.
const BUY_MAX_TP_HOLDERS = 150;
const BUY_MAX_HOLDERS = 300;
const BUY_MAX_SNIPERS_PCT = 1;
// Bundle growth (entry → now) above this ratio = insiders stacking wallets in
// minutes: the measured death sentence (0 of 25 tokens that grew ≥1.5x through
// minute 3 ended above; AUC 0.06 — the strongest separator in the dataset).
const BUY_MAX_QUIET_RATIO = 1.4;

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── config (its own proxy + filters, both independent from the app columns) ──

export function getTrackConfig() {
  const stored = trackConfig.get('global') ?? {};
  // The tracker's OWN proxy — never the FOMO/Photon one; junk in the store reads as ''.
  let proxy = '';
  try {
    proxy = stored.proxy ? normalizeProxy(stored.proxy) : envProxy();
  } catch {
    proxy = '';
  }
  const storedFilters = sanitizeColumnFilters(stored.filters);
  return {
    enabled: stored.enabled !== false, // default on: it works out of the box
    proxy,
    // A wiped store (Railway restarts have no disk) falls back to the env floor, so a
    // redeploy can't silently lose the setup the user saved from the app.
    filters: Object.keys(storedFilters).length ? storedFilters : envFilters(),
  };
}

/** TRACK_PROXY env — restart-safe floor for the track's own proxy. */
function envProxy() {
  try {
    return process.env.TRACK_PROXY ? normalizeProxy(process.env.TRACK_PROXY) : '';
  } catch {
    return '';
  }
}

/** TRACK_FILTERS='{"holders":{"min":"60"}}' — same shape as the store, sanitized. */
function envFilters() {
  try {
    return sanitizeColumnFilters(JSON.parse(process.env.TRACK_FILTERS ?? '{}'));
  } catch {
    return {};
  }
}

/** Omitted fields keep their stored value — a partial PUT never wipes the rest. */
export function setTrackConfig(raw) {
  const stored = trackConfig.get('global') ?? {};
  let proxy = stored.proxy ?? '';
  if (raw?.proxy !== undefined) {
    try {
      proxy = normalizeProxy(raw.proxy); // '' allowed → cleared
    } catch (err) {
      throw Object.assign(new Error(err.message), { status: 400 }); // the app flashes this
    }
  }
  trackConfig.set('global', {
    enabled: raw?.enabled != null ? Boolean(raw.enabled) : stored.enabled !== false,
    proxy,
    filters: sanitizeColumnFilters(raw?.filters ?? stored.filters),
    updated_at: new Date().toISOString(),
  });
  return getTrackConfig();
}

/**
 * One minute's worth of the stats the analysis runs on.
 *
 * El 17/oct se midió cada campo sobre el dump de prod (486 tokens / 8.108
 * snapshots, horizonte fijo 5/10/20/30 min): se dejaron de capturar INS
 * (insiderPct), KOL (kolCount), fresh %/holders, V5m y PRO·AZ por ser ruido
 * (ρ≈0 en los cuatro horizontes), y el SCORE 0-6 por no reproducir su promesa
 * (x2 monótono 21→41→68→73%, base 30%) en el dataset actual.
 */
function snapshotOf(a, pulse, card, thesis, chat, callout, pos, top) {
  const mcap = numOrNull(a.fdv);
  const holders = numOrNull(a.holders_count);
  return {
    at: new Date().toISOString(),
    mcap,
    volume: numOrNull(a.volume),
    buys: numOrNull(a.buys_count),
    sells: numOrNull(a.sells_count),
    holders,
    topHoldersPct: numOrNull(a.audit?.top_holders_perc),
    snipersPct: numOrNull(a.snipers_holding_perc),
    snipers: numOrNull(a.snipers_count),
    bundlePct: numOrNull(a.bundle_holding_perc),
    bundleHolders: numOrNull(a.bundle_holders_count),
    tpHolders: numOrNull(a.tp_holders_count),
    // Trenchers Pulse (fuente 2, una llamada por token por minuto — probado
    // con 20 en paralelo sin rate limit). Un fallo de esta fuente deja nulls:
    // el snapshot de Photon NUNCA se pierde por una fuente extra caída.
    smartTraderPct: pulse?.smartTraderPct ?? null,
    proTraders: pulse?.proTraders ?? null,
    creatorMints: pulse?.creatorMints ?? null,
    creatorGraduated: pulse?.creatorGraduated ?? null,
    // Azura getCard (fuente 3): seguridad y split de volumen 1h. El ritmo a 5m
    // (volChange5m) y el pro-trader propio de Azura (proTradersAz) se sacaron
    // el 17/oct (ruido); el resto sigue guardándose aunque la UI no lo pinte.
    overallSecurity: card?.overallSecurity ?? null,
    securityFlags: card?.securityFlags ?? null,
    volChange1h: card?.volChange1h ?? null,
    buyVol5m: card?.buyVol5m ?? null,
    sellVol5m: card?.sellVol5m ?? null,
    buyVol1h: card?.buyVol1h ?? null,
    sellVol1h: card?.sellVol1h ?? null,
    // FOMO thesis (fuente 4): tesis de traders con plata real adjunta, ≥$1K.
    thesesCount: thesis?.thesesCount ?? null,
    thesesOpen: thesis?.thesesOpen ?? null,
    thesesUsd: thesis?.thesesUsd ?? null,
    thesesPnlAvg: thesis?.thesesPnlAvg ?? null,
    thesesEntryMcap: thesis?.thesesEntryMcap ?? null,
    // GMGN chat (fuente 5): ACUMULATIVO desde la entrada al track — mensajes
    // totales vistos, wallets únicas que hablaron, su plata y su PnL.
    chatMsgs: chat?.chatMsgs ?? null,
    chatWallets: chat?.chatWallets ?? null,
    chatHoldersUsd: chat?.chatHoldersUsd ?? null,
    chatPnlAvg: chat?.chatPnlAvg ?? null,
    chatKols: chat?.chatKols ?? null,
    // Pump callout (fuente 6): una sola petición por token, guardada en el token
    // y volcada en cada snapshot (los callouts históricos no cambian).
    calloutsTotal: callout?.calloutsTotal ?? null,
    calloutsUsd: callout?.calloutsUsd ?? null,
    calloutsUpPct: callout?.calloutsUpPct ?? null,
    calloutsEntryMcap: callout?.calloutsEntryMcap ?? null,
    calloutsVerified: callout?.calloutsVerified ?? null,
    // Pump positions (fuente 7, VIVA — se lee en cada snapshot): holders
    // visibles y sus callouts separados por plata metida (≥$100 vs <$100,
    // más los rangos que pinta la UI: [$100,$500) y ≥$500).
    posHolders: pos?.holders ?? null,
    posHoldersTotal: pos?.holdersTotal ?? null,
    callout100: pos?.callout100 ?? null,
    calloutLt100: pos?.calloutLt100 ?? null,
    callout100to500: pos?.callout100to500 ?? null,
    callout500: pos?.callout500 ?? null,
    // Top traders del token (fuente 9): el ranking propio de pump.fun por
    // token — traders con rank ≤50 y ≥$100 comprados, separados por board
    // (daily / weekly / monthly) + sus usernames.
    topDaily: top?.topDaily ?? null,
    topWeekly: top?.topWeekly ?? null,
    topMonthly: top?.topMonthly ?? null,
    topTraderNames: top?.topTraderNames ?? null,
  };
}

// ── Trenchers Pulse ──────────────────────────────────────────────────────────
// The tracker's second source: Photon gives the column (holders/bots/snipers/
// bundle), Pulse adds what no column has — % de smart traders (rentables) y el
// historial de lanzamientos del dev. Probed: 20 parallel calls, all 200, no rate
// limit headers, ~0.5s. A timeout keeps a slow Pulse from stalling the tick.
const PULSE_URL = 'https://pulse-production.trenchers.ai/pulse/token/';
const PULSE_TIMEOUT_MS = 5_000;

async function fetchPulse(address) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PULSE_TIMEOUT_MS);
    const res = await fetch(`${PULSE_URL}${address}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    return {
      smartTraderPct: numOrNull(j.smart_trader_pct),
      proTraders: numOrNull(j.pro_traders_count),
      creatorMints: numOrNull(j.creator_stats?.mints_created),
      creatorGraduated: numOrNull(j.creator_stats?.mints_graduated),
    };
  } catch {
    return null; // caída o timeout → nulls en el snapshot, el tick sigue
  }
}

/** ¿Le toca snapshot a este token en este tick? (la MISMA regla del loop). */
function snapshotDue(tracked) {
  if (!tracked) return true; // nuevo en la columna → primer snapshot ya
  if (tracked.status !== 'active') return false;
  if (tracked.snapshots.length >= TRACK_SNAPSHOT_MAX) return false;
  const lastAt = tracked.snapshots[tracked.snapshots.length - 1]?.at;
  return !lastAt || Date.now() - Date.parse(lastAt) >= SNAPSHOT_MS;
}

// ── Azura getCard (fuente 3) ─────────────────────────────────────────────────
// Same probe profile as Pulse: 20 parallel calls, all 200, no rate limit.
// Contributes what neither Photon nor Pulse has: the security audit (wash
// trading / fake volume / honeypot flags) y el split de volumen 1h. El ritmo a
// 5m y el pro-trader propio de Azura salieron el 17/oct (ruido).
const AZURA_URL = 'https://gateway.azura.xyz/trpc/v2.tokens.getCard';
const AZURA_TIMEOUT_MS = 5_000;

async function fetchAzura(address) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AZURA_TIMEOUT_MS);
    const input = encodeURIComponent(JSON.stringify({ json: { chainId: 1399811149, tokenAddress: address } }));
    const res = await fetch(`${AZURA_URL}?input=${input}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const card = (await res.json())?.result?.data?.json;
    if (!card) return null;
    const flags = card.securityDetails?.flags;
    return {
      overallSecurity: typeof card.securityDetails?.overallSecurity === 'string' ? card.securityDetails.overallSecurity : null,
      // Solo los flags encendidos (un array vacío = auditoría limpia): guardar
      // los 20 niveles con su "LOW" repetido solo ensucia el snapshot.
      securityFlags: flags
        ? Object.entries(flags)
            .filter(([, f]) => f?.value === true)
            .map(([name]) => name)
        : null,
      volChange1h: numOrNull(card.stats?.volume?.['1h']?.change),
      buyVol5m: numOrNull(card.stats?.volume?.['5m']?.buyVolume),
      sellVol5m: numOrNull(card.stats?.volume?.['5m']?.sellVolume),
      buyVol1h: numOrNull(card.stats?.volume?.['1h']?.buyVolume),
      sellVol1h: numOrNull(card.stats?.volume?.['1h']?.sellVolume),
    };
  } catch {
    return null; // caída o timeout → nulls, el tick sigue igual
  }
}

// ── Fuentes sociales (4-6): FOMO thesis, GMGN chat, pump callout ────────────
// Todas pasan el WAF solo con impersonación Chrome — tanto prod-api.fomo.family
// como gmgn.ai devuelven "unauthorized"/403 a clientes que no parezcan Chrome
// (ni siquiera a /public/prices), así que van por cycletls como Photon.
const SOCIAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const SOCIAL_TIMEOUT_MS = 8_000;

/** cycletls devuelve `data` ya parseado (objeto) o como string JSON según el
 *  contenido; un error no-200 (404 Buffer, WAF) se descarta. */
const tlsJson = (resp) => {
  if (resp?.status !== 200) return null;
  if (resp.data && typeof resp.data === 'object') return resp.data;
  if (typeof resp.data !== 'string') return null;
  try {
    return JSON.parse(resp.data);
  } catch {
    return null;
  }
};

/** cycletls no expone timeout por request — un límite externo evita colgar el tick. */
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

// ── FOMO thesis (fuente 4) ──────────────────────────────────────────────────
// Las "tesis" de FOMO family: cada trae la posición REAL del autor (authorTrade
// .usdValue, PnL sin realizar, mcap al publicar). El endpoint filtra con
// `threshold` (≥ $1K por decisión del usuario) y ventana de una hora. Requiere
// la cookie privy-token: el mismo customer access token del refresh que ya
// usa el feed WS (getAccessToken de fomo.js).
const THESIS_URL = 'https://prod-api.fomo.family/feed/token/sortedThesis';
const THESIS_MIN_USD = 1_000;
const THESIS_WINDOW_MS = 3_600_000;

/**
 * GET de FOMO con conmutación de transporte: en producción la IP de Railway
 * recibe 432 del WAF (por eso el WS del feed sale por el proxy compartido) —
 * se intenta por proxy primero y se cae a directo (en local no hay proxy y
 * la IP de casa pasa el WAF directa).
 */
async function fomoThesisGet(url, headers) {
  const attempts = [];
  const proxyUrl = getEffectiveProxy();
  if (proxyUrl) attempts.push({ proxy: proxyUrl });
  attempts.push({}); // directo
  for (const opts of attempts) {
    try {
      const resp = await withTimeout(
        getCycleTLS().then((c) => c(url, { client: 'chrome131', headers, ...opts }, 'get')),
        SOCIAL_TIMEOUT_MS,
      );
      if (resp?.status === 200) return resp;
    } catch {
      // transporte caído o timeout → siguiente intento
    }
  }
  return null;
}

export async function fetchFomoThesis(address) {
  try {
    const jwt = await getAccessToken();
    const url =
      `${THESIS_URL}?tokenAddress=${address}&networkId=1399811149` +
      `&afterTime=${Date.now() - THESIS_WINDOW_MS}&limit=80&threshold=${THESIS_MIN_USD}`;
    const resp = await fomoThesisGet(url, {
      accept: '*/*',
      'app-language': 'es',
      'content-type': 'application/json',
      cookie: `privy-session=privy.fomo.family; privy-token=${jwt}`,
      origin: 'https://fomo.family',
      referer: 'https://fomo.family/',
      'user-agent': SOCIAL_UA,
      'x-supported-chains': '1,56,143,4663,5042,8453,1399811149',
    });
    const items = tlsJson(resp)?.responseObject?.items;
    if (!Array.isArray(items)) return null;
    let usd = 0;
    let pnlSum = 0;
    let pnlN = 0;
    let mcapSum = 0;
    let mcapN = 0;
    let open = 0;
    for (const it of items) {
      const trade = it?.authorTrade;
      const v = numOrNull(trade?.usdValue);
      if (v != null) usd += v;
      if (trade?.closedAt == null) open += 1;
      const pnl = numOrNull(trade?.percentageUnrealizedPnl);
      if (pnl != null) {
        pnlSum += pnl;
        pnlN += 1;
      }
      const mc = numOrNull(it?.comment?.marketCapAtCreation);
      if (mc != null) {
        mcapSum += mc;
        mcapN += 1;
      }
    }
    return {
      thesesCount: items.length,
      thesesOpen: open,
      thesesUsd: Math.round(usd),
      thesesPnlAvg: pnlN ? Math.round((pnlSum / pnlN) * 10) / 10 : null,
      thesesEntryMcap: mcapN ? Math.round(mcapSum / mcapN) : null,
    };
  } catch {
    return null; // sin refresh token FOMO o WAF → nulls, el tick sigue
  }
}

// ── GMGN chat (fuente 5 — el "callout" de GMGN) ─────────────────────────────
// El chat de la comunidad del token: cada mensaje trae la posición VIVA del
// autor (holding USD, PnL sin realizado, KOL). Se cuentan los últimos 5 min y
// se deduplica por wallet — un spammer no debe inflar la plata puesta.
// Sin params de fingerprint: probado con solo `?limit=50` → 200.
const GMGN_MSGS_URL = (address) =>
  `https://gmgn.ai/api/v1/token/sol/${address}/community/messages?limit=50`;
const GMGN_HEADERS = {
  accept: 'application/json, text/plain, */*',
  origin: 'https://gmgn.ai',
  referer: 'https://gmgn.ai/',
  'user-agent': SOCIAL_UA,
};

/**
 * ACUMULATIVO (decisión del usuario): cada snapshot pide los últimos 50
 * mensajes y los vuelca en el acumulador del token (`tracked.chatAcc`,
 * persistido con él) deduplicando por `id` — chatMsgs cuenta TODO lo visto
 * desde que el token entró al track, no una ventana. Los agregados
 * (USD/PnL/KOLs) se recalculan sobre las wallets ÚNICAS acumuladas.
 * Tope práctico: si el chat emite >50 mensajes/min se pierde la cola vieja
 * entre fetch y fetch (50/min es lo que el endpoint expone por página).
 */
export async function fetchGmgnMessages(address, acc) {
  try {
    const resp = await withTimeout(
      getCycleTLS().then((c) => c(GMGN_MSGS_URL(address), { client: 'chrome131', headers: GMGN_HEADERS }, 'get')),
      SOCIAL_TIMEOUT_MS,
    );
    const msgs = tlsJson(resp)?.data?.messages;
    if (!Array.isArray(msgs)) return null;
    for (const m of msgs) {
      const key = m?.id;
      if (!key || acc.seen[key]) continue; // ya contado en un minuto anterior
      acc.seen[key] = 1;
      acc.msgs += 1;
      const w = m.wallet_address;
      if (w && acc.wallets[w] == null) {
        const pnl = numOrNull(m.unrealized_profit_pnl); // FRACCIÓN → %
        acc.wallets[w] = {
          usd: numOrNull(m.current_holding_usd),
          pnl: pnl != null ? pnl * 100 : null,
          kol: Boolean(m.is_kol),
        };
      }
    }
    let holdersUsd = 0;
    let pnlSum = 0;
    let pnlN = 0;
    let kols = 0;
    for (const w of Object.values(acc.wallets)) {
      if (w.usd != null) holdersUsd += w.usd;
      if (w.pnl != null) {
        pnlSum += w.pnl;
        pnlN += 1;
      }
      if (w.kol) kols += 1;
    }
    return {
      chatMsgs: acc.msgs,
      chatWallets: Object.keys(acc.wallets).length,
      chatHoldersUsd: Math.round(holdersUsd),
      chatPnlAvg: pnlN ? Math.round((pnlSum / pnlN) * 10) / 10 : null,
      chatKols: kols,
    };
  } catch {
    return null;
  }
}

// ── Pump callout (fuente 6 — SOLO el primer snapshot) ───────────────────────
// Los callouts de la pump.fun sobre el token: quién lo llamó, a qué mcap
// (called_out_at_mcap), cuánto puso (position.value_usd) y su PnL. Devuelve
// hasta 200 items SIN ventana (~240KB/token) — por eso se pide UNA vez por
// token, al entrar a la columna: los callouts históricos ya no cambian.
const GMGN_CALLOUT_URL = (address) =>
  `https://gmgn.ai/pf/api/v1/pump/callout/token?chain=sol&token=${address}`;
const CALLOUT_WINDOW_MS = 3_600_000;
const CALLOUT_BACKFILL_PER_TICK = 20; // tope de relleno por tick (~240KB c/u)

export async function fetchPumpCallout(address) {
  try {
    const resp = await withTimeout(
      getCycleTLS().then((c) => c(GMGN_CALLOUT_URL(address), { client: 'chrome131', headers: GMGN_HEADERS }, 'get')),
      SOCIAL_TIMEOUT_MS,
    );
    const items = tlsJson(resp)?.data?.items;
    if (!Array.isArray(items)) return null;
    const cutoff = Date.now() - CALLOUT_WINDOW_MS;
    const recent = items.filter((it) => (numOrNull(it?.created_at) ?? 0) >= cutoff);
    let usd = 0;
    let pnlSum = 0;
    let pnlN = 0;
    let mcapSum = 0;
    let mcapN = 0;
    let verified = 0;
    for (const it of recent) {
      if (it?.is_verified) verified += 1;
      const pos = it?.position;
      const v = numOrNull(pos?.value_usd);
      if (v != null && !pos.is_exited) usd += v;
      const pnl = numOrNull(pos?.pnl_percentage); // ya viene en %
      if (pnl != null) {
        pnlSum += pnl;
        pnlN += 1;
      }
      const mc = numOrNull(it?.called_out_at_mcap);
      if (mc != null) {
        mcapSum += mc;
        mcapN += 1;
      }
    }
    return {
      calloutsTotal: recent.length,
      calloutsUsd: Math.round(usd),
      calloutsUpPct: pnlN ? Math.round((pnlSum / pnlN) * 10) / 10 : null,
      calloutsEntryMcap: mcapN ? Math.round(mcapSum / mcapN) : null,
      calloutsVerified: verified,
    };
  } catch {
    return null;
  }
}

// ── Pump positions (fuente 7) + PnL leaderboard (fuente 8) ──────────────────
// mint-positions de frontend-api-v3.pump.fun: los holders del token con su
// callout embebido (thesis, entry mcap, views) y SU PLATA metida
// (amountBoughtUsd). Sondeo: 200 directo (sin WAF, a diferencia de FOMO/GMGN),
// 20/20 en paralelo a ~26 ms/req, respuestas de 1.3-70KB. Se lee VIVA en cada
// snapshot (la lista cambia minuto a minuto; totalCount decae al cerrarse
// posiciones). El primer parámetro filtra con `withThesis=true`, que trae el
// callout de cada holder — la métrica del usuario: callouts con ≥$100 metidos
// separados de los que pusieron <$100.
const PUMP_POS_URL = (address) =>
  `https://frontend-api-v3.pump.fun/mint-positions/${address}?sortBy=TOP&withThesis=true&pageSize=50`;
const PUMP_POS_TOP_USD = 100; // barra "con plata" del callout
const PUMP_POS_MID_USD = 500; // barra del rango alto que pinta la UI
const PUMP_HEADERS = {
  accept: 'application/json, text/plain, */*',
  origin: 'https://pump.fun',
  referer: 'https://pump.fun/',
  'user-agent': SOCIAL_UA,
};

/** GET a pump.fun: directo primero (pasa el WAF), cycletls chrome131 de respaldo. */
async function pumpGet(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SOCIAL_TIMEOUT_MS);
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) return await res.json();
  } catch {
    // directo bloqueado o caído → se intenta con cycletls
  }
  try {
    const resp = await withTimeout(
      getCycleTLS().then((c) => c(url, { client: 'chrome131', headers: PUMP_HEADERS }, 'get')),
      SOCIAL_TIMEOUT_MS,
    );
    return tlsJson(resp);
  } catch {
    return null;
  }
}

export async function fetchPumpPositions(address) {
  const j = await pumpGet(PUMP_POS_URL(address));
  const positions = j?.positions;
  if (!Array.isArray(positions)) return null;
  let callout100 = 0;
  let calloutLt100 = 0;
  // Rangos que pinta la UI (por decisión del usuario): [$100, $500) y ≥$500.
  // callout100 (≥$100) se conserva igual — es la métrica validada en análisis.
  let callout100to500 = 0;
  let callout500 = 0;
  // Las DIRECCIONES de los callouts ≥$100 (fuente 10): vienen en la misma
  // respuesta, así que guardarlas no cuesta ni un request — es lo que permite
  // detectar una ENTRADA (wallet que no estaba y ahora sí) y leerle su PnL.
  const call100Wallets = [];
  for (const p of positions) {
    if (!p?.callout) continue; // solo holders que además dejaron su callout público
    const usd = numOrNull(p.amountBoughtUsd) ?? 0;
    if (usd >= PUMP_POS_TOP_USD) {
      callout100 += 1;
      const wallet = String(p.walletAddress ?? '');
      if (wallet) call100Wallets.push({ address: wallet, usd: Math.round(usd) });
    } else calloutLt100 += 1; // <$100 o monto desconocido
    if (usd >= PUMP_POS_MID_USD) callout500 += 1;
    else if (usd >= PUMP_POS_TOP_USD) callout100to500 += 1;
  }
  return {
    holders: positions.length, // visibles en la página (hasta 50)
    holdersTotal: numOrNull(j.totalCount),
    callout100,
    calloutLt100,
    callout100to500,
    callout500,
    call100Wallets,
  };
}

// ── Entradas CAL100: el PnL del portfolio de la wallet que entró (fuente 10) ──
/**
 * Cuando una wallet con callout ≥$100 APARECE entre los holders visibles de un
 * token trackeado DESPUÉS de que ya estábamos mirando el token, eso es un EVENTO
 * del token (el minuto, como el "min 3" del usuario) y se le pregunta su PnL de
 * portfolio — ventanas 1d y 1w — para dejarlo como una fila de esa entrada. Es
 * una lectura de ENTRADA (una vez por token+wallet), no un seguimiento. Las que
 * ya estaban en el primer snapshot son línea base, no entrada.
 *
 * Por qué así y no "todas las wallets cada minuto": el conteo de callout100 se
 * repite en cada snapshot (medido: suma 198 por token en su vida, ~12 por
 * snapshot), pero las wallets NUEVAS son pocas y se piden UNA vez. Con dedupe
 * por token+wallet el costo pasa de miles por barrido a unos pocos por minuto.
 *
 * /portfolio-summary no acepta batch (`user=a,b` → 400) y está detrás de
 * Cloudflare (fetch directo → 403, siempre), así que cada wallet son 2 requests
 * por cycletls: de ahí el paralelismo corto, la caché por wallet (la misma
 * wallet llama varios tokens seguidos) y el tope de intentos ("sin dato" antes
 * que insistir para siempre).
 */
const CALL100_PNL_URL = (wallet, period) =>
  `https://frontend-api-v3.pump.fun/portfolio-summary?user=${encodeURIComponent(wallet)}&period=${period}`;
const CALL100_CACHE_MS = 15 * 60_000; // la misma wallet en otro token, dentro de 15 min
const CALL100_CONCURRENCY = 3; // wallets en paralelo (2 requests c/u)
const CALL100_MAX_TRIES = 2; // 2 intentos y la fila queda sin dato
const CALL100_EVENTS_MAX = 100; // tope de filas por token (el dedupe va en call100Seen)
const CALL100_SWEEP_MS = 2_000; // ritmo del barrido de filas sin PnL

const call100Cache = new Map(); // wallet → lectura (at + 1d/1w)
const call100Inflight = new Set(); // "token|wallet" en vuelo (no vive en el store)
let call100Timer = null;

/**
 * PnL del portfolio de una wallet en las dos ventanas. `pnl.usd` es el número
 * que decide el signo; `percentage.usd` se guarda pero no se pinta crudo (en
 * `all` da barbaridades: divide por capital desplegado, no por equity) y
 * `tokenCount` distingue "0,00 porque no operó" de "0,00 de verdad".
 * Todo null = no se cachea, para poder reintentar.
 */
async function fetchWalletPnl(wallet) {
  const hit = call100Cache.get(wallet);
  if (hit && Date.now() - hit.at < CALL100_CACHE_MS) return hit;
  const [day, week] = await Promise.all([
    pumpGet(CALL100_PNL_URL(wallet, '1d')),
    pumpGet(CALL100_PNL_URL(wallet, '1w')),
  ]);
  const read = {
    at: Date.now(),
    pnl1dUsd: numOrNull(day?.pnl?.usd),
    pnl1dPct: numOrNull(day?.percentage?.usd),
    tokens1d: numOrNull(day?.tokenCount),
    pnl1wUsd: numOrNull(week?.pnl?.usd),
    pnl1wPct: numOrNull(week?.percentage?.usd),
    tokens1w: numOrNull(week?.tokenCount),
  };
  // Solo se cachea la lectura COMPLETA (las dos ventanas). Una parcial se
  // devuelve igual —para no volver a pedir con la fila fresca— pero deja la fila
  // incompleta y el barrido la reintenta hasta CALL100_MAX_TRIES.
  if (read.pnl1dUsd != null && read.pnl1wUsd != null) call100Cache.set(wallet, read);
  return read;
}

/**
 * Filas nuevas del token: una por wallet ≥$100 que APARECE DESPUÉS de que ya
 * estábamos mirando el token. El PRIMER snapshot sólo siembra la línea base (lo
 * que ya estaba cuando empezamos a mirar no es una entrada — tampoco al
 * desplegar sobre tokens que vienen corriendo), y `call100Seen` es el dedupe: una
 * wallet ya vista no vuelve a contar aunque el top-50 se reordene. La fila nace
 * sin PnL y sweepCall100 la completa.
 */
function detectCall100Entries(tracked, wallets, minute, at) {
  const firstLook = !tracked.call100Seen;
  const seen = (tracked.call100Seen = tracked.call100Seen ?? {});
  const list = Array.isArray(wallets) ? wallets : [];
  if (!list.length) return 0; // el primer look vacío también consume la línea base
  const events = (tracked.call100Events = Array.isArray(tracked.call100Events) ? tracked.call100Events : []);
  let added = 0;
  for (const w of list) {
    const address = String(w?.address ?? '');
    if (!address || seen[address] != null) continue;
    seen[address] = minute;
    if (firstLook) continue; // línea base
    if (events.length >= CALL100_EVENTS_MAX) break;
    events.push({
      minute,
      at,
      address,
      usd: w?.usd ?? null,
      tries: 0,
      pnl1dUsd: null,
      pnl1dPct: null,
      tokens1d: null,
      pnl1wUsd: null,
      pnl1wPct: null,
      tokens1w: null,
    });
    added += 1;
  }
  return added;
}

/**
 * Un barrido resuelve hasta CALL100_CONCURRENCY filas sin datos, reintentando
 * las que fallaron hasta CALL100_MAX_TRIES. Lo corre su propio timer
 * (CALL100_SWEEP_MS) y NO el tick: así el PnL de una wallet nunca demora un
 * snapshot ni la siguiente vuelta de la columna, y las filas pendientes se
 * resuelven aunque el track esté pausado. Nada de requests si el tracker está
 * apagado. `get()` devuelve el MISMO objeto del store, así que escribir la
 * lectura es mutar la fila y marcar el store para persistir.
 */
function sweepCall100() {
  if (!getTrackConfig().enabled) return; // apagado = ni un request
  const slots = CALL100_CONCURRENCY - call100Inflight.size;
  if (slots <= 0) return;
  const jobs = [];
  for (const t of Object.values(trackTokens.getAll())) {
    for (const e of t?.call100Events ?? []) {
      if (e.pnl1dUsd != null && e.pnl1wUsd != null) continue; // completa
      if ((e.tries ?? 0) >= CALL100_MAX_TRIES) continue; // sin dato, no insistir
      const key = `${t.address}|${e.address}`;
      if (call100Inflight.has(key)) continue;
      // Sin reparto por token: un token con muchas entradas (medido: hasta 45
      // callouts ≥$100 en un snapshot) se vacía a la velocidad del paralelismo,
      // no una por vuelta.
      jobs.push({ key, address: t.address, wallet: e.address });
      if (jobs.length >= slots) break;
    }
    if (jobs.length >= slots) break;
  }
  for (const job of jobs) {
    call100Inflight.add(job.key);
    void fetchWalletPnl(job.wallet)
      .then((read) => {
        const live = trackTokens.get(job.address);
        const event = live?.call100Events?.find((x) => x.address === job.wallet);
        if (!event) return;
        event.pnl1dUsd = read.pnl1dUsd;
        event.pnl1dPct = read.pnl1dPct;
        event.tokens1d = read.tokens1d;
        event.pnl1wUsd = read.pnl1wUsd;
        event.pnl1wPct = read.pnl1wPct;
        event.tokens1w = read.tokens1w;
        event.tries = (event.tries ?? 0) + 1;
        trackTokens.set(job.address, live);
        maybeBroadcast(true);
        // Aviso CAL100+ (ver emitTrackCal100Pos en notify.js): la fila quedó EN
        // VERDE —alguna ventana > 0, la misma regla que pinta la UI— y este es el
        // único momento en que eso se sabe: el PnL no está en el snapshot, lo trajo
        // este barrido. Sin umbral (decisión del usuario) y una vez por token+wallet
        // (dedupe del emisor): una fila con una ventana null se reintenta y esa
        // segunda lectura no debe avisar de nuevo.
        if ((event.pnl1dUsd ?? 0) > 0 || (event.pnl1wUsd ?? 0) > 0) {
          const lastSnap = live?.snapshots?.[live.snapshots.length - 1];
          // Identidad del token para el aviso: symbol/name/logo viven en el tracked
          // y el mcap/vol/holders en su último snapshot (la fila no los trae).
          emitTrackCal100Pos(
            {
              address: job.address,
              symbol: live?.symbol ?? null,
              name: live?.name ?? null,
              logo: live?.logo ?? null,
              mcap: lastSnap?.mcap ?? null,
              volume: lastSnap?.volume ?? null,
              holders: lastSnap?.holders ?? null,
            },
            event,
          );
        }
      })
      .catch(() => {
        /* la fila queda sin dato y el próximo barrido reintenta */
      })
      .finally(() => call100Inflight.delete(job.key));
  }
}

// ── Top traders del token (fuente 9) ─────────────────────────────────────────
// El endpoint top-trader-trades del propio ranking de pump.fun devuelve, POR
// TOKEN, sus top traders (username, verificado, bestRank, boards donde rankea)
// y TODOS sus trades (isBuy/amountUsd). Reemplaza al cruce viejo
// leaderboard × topPositions —que solo veía las ~5 posiciones más grandes de
// cada trader y daba TOP 0 casi siempre—. Por decisión del usuario:
//   · solo traders con rank ≤ 50 en al menos un board;
//   · solo si compraron ≥ $100 (acumulado de sus compras, contando todas sus
//     tradingWallets);
//   · las 3 métricas van separadas: daily / weekly / monthly.
// 8-34KB por token, directo (sin WAF, sin auth) — se lee en cada snapshot.
const PUMP_TOP_URL = (address) =>
  `https://frontend-api-v3.pump.fun/pnl-leaderboard/top-trader-trades/${address}`;
const PUMP_TOP_MAX_RANK = 50;
const PUMP_TOP_MIN_USD = 100;

export async function fetchPumpTopTraders(address) {
  const j = await pumpGet(PUMP_TOP_URL(address));
  const traders = j?.traders;
  if (!Array.isArray(traders)) return null;
  const trades = Array.isArray(j?.trades) ? j.trades : [];
  let topDaily = 0;
  let topWeekly = 0;
  let topMonthly = 0;
  const names = [];
  for (const tr of traders) {
    const rank = numOrNull(tr.bestRank);
    if (rank == null || rank > PUMP_TOP_MAX_RANK) continue; // fuera del top 50
    // El trader puede operar con varias wallets — las compras se suman todas.
    const wallets = new Set([tr.walletAddress, ...(Array.isArray(tr.tradingWallets) ? tr.tradingWallets : [])]);
    let boughtUsd = 0;
    for (const t of trades) {
      if (t?.isBuy && wallets.has(t.walletAddress)) boughtUsd += numOrNull(t.amountUsd) ?? 0;
    }
    if (boughtUsd < PUMP_TOP_MIN_USD) continue; // sin plata real adjunta
    const periods = Array.isArray(tr.periods) ? tr.periods : [];
    if (periods.includes('daily')) topDaily += 1;
    if (periods.includes('weekly')) topWeekly += 1;
    if (periods.includes('monthly')) topMonthly += 1;
    if (tr.username) names.push(tr.username);
  }
  return {
    topDaily,
    topWeekly,
    topMonthly,
    topTraderNames: names.length ? names.slice(0, 10) : null,
  };
}

/**
 * Hard gate: the tracker idles until its OWN proxy is saved (never the
 * FOMO/Photon one — the track doesn't egress without its own) and the filter
 * set has at least one field. No proxy, no entries; no filters, no entries.
 */
export function getTrackGate() {
  const config = getTrackConfig();
  let proxyOk = false;
  let proxyUrl = '';
  try {
    proxyUrl = config.proxy ? normalizeProxy(config.proxy) : '';
    proxyOk = Boolean(proxyUrl);
  } catch {
    proxyOk = false;
  }
  const filtersOk = Object.keys(config.filters).length > 0;
  return {
    ok: proxyOk && filtersOk,
    proxy: { ok: proxyOk, url: proxyUrl },
    filters: { ok: filtersOk, count: Object.keys(config.filters).length },
  };
}

// ── transport (own client, own backoff) ──────────────────────────────────────

let cycleTLS = null;
let transport = 'direct';
let poller = null;
let trackInflight = null;
const missCount = new Map(); // address → consecutive pulls absent (pause grace, in-memory)
let backoffUntil = 0;
let fetchCount = 0;
let errorCount = 0;
let lastError = null;
let lastFetchAt = 0;
let gateLogged = false;

async function getCycleTLS() {
  if (!cycleTLS) cycleTLS = await initCycleTLS();
  return cycleTLS;
}

export async function closeTrack() {
  if (poller) clearInterval(poller);
  poller = null;
  if (call100Timer) clearInterval(call100Timer);
  call100Timer = null;
  if (cycleTLS) {
    const c = cycleTLS;
    cycleTLS = null;
    try {
      await c.exit();
    } catch {}
  }
}

/**
 * Fetches the Graduated column with the track's OWN filters handed to Photon as
 * query params — the exact mechanism the app's Photon screen uses (buildQuery),
 * so "passed the filters" means the same thing on both screens.
 */
async function fetchGraduated() {
  fetchCount += 1;
  const client = await getCycleTLS();
  // The gate guarantees the track's own proxy is here; it is the ONLY egress —
  // no silent fallback to direct (that IP is exactly what the user is avoiding).
  const config = getTrackConfig();
  const proxyUrl = config.proxy;
  transport = proxyUrl ? 'proxy' : 'direct';
  const request = client(
    `${SEARCH_URL}?${buildQuery('col3', config.filters)}`,
    { client: 'chrome131', headers: HEADERS, ...(proxyUrl ? { proxy: proxyUrl } : {}) },
    'GET',
  );
  let timer;
  let resp;
  try {
    resp = await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT_${FETCH_TIMEOUT_MS}MS`)), FETCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    request.catch(() => {});
  }

  const status = Number(resp?.status) || 0;
  if (status === 429) {
    backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    throw Object.assign(new Error('RATE_LIMITED'), { rateLimited: true });
  }
  if (status !== 200) {
    // CycleTLS reports an unreachable/broken proxy as a bare 401 — say it plainly.
    throw new Error(proxyUrl && status === 401 ? 'PROXY_401 (el proxy no respondió o rechazó)' : `HTTP_${status}`);
  }

  return toItems(resp);
}

/** CycleTLS hands the body over parsed (object) or as raw bytes — accept both. */
function toItems(resp) {
  const raw = resp?.data;
  let json;
  if (raw != null && typeof raw === 'object' && !Buffer.isBuffer(raw)) {
    json = raw;
  } else {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('BAD_BODY');
    }
  }
  if (json.error) throw new Error(String(json.error));
  const slice = json.columns?.col3 ?? { data: [] };
  const items = Array.isArray(slice.data) ? slice.data : [];
  return items.map((it) => it?.attributes).filter(Boolean);
}

// ── proxy test (the app's "Probar" button) ───────────────────────────────────

/**
 * One real Graduated fetch through a proxy, timed — the app's way of knowing
 * whether the proxy works BEFORE trusting it with tracking. Accepts an unsaved
 * draft (testing doesn't require saving first) and never throws: every outcome
 * comes back shaped, so the UI can just print it.
 */
export async function testTrackProxy(rawProxy) {
  let proxyUrl = '';
  try {
    proxyUrl = normalizeProxy(rawProxy ?? getTrackConfig().proxy);
  } catch (err) {
    return { ok: false, stage: 'config', ms: 0, error: String(err?.message || err) };
  }
  if (!proxyUrl) return { ok: false, stage: 'config', ms: 0, error: 'no hay proxy cargado' };

  const started = Date.now();
  const request = (await getCycleTLS())(
    // Same query the tracker will really use (its own filters as Photon params):
    // testing any other URL would say nothing about the tracking fetch itself.
    `${SEARCH_URL}?${buildQuery('col3', getTrackConfig().filters)}`,
    { client: 'chrome131', headers: HEADERS, proxy: proxyUrl },
    'GET',
  );
  let timer;
  let resp;
  try {
    resp = await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT_${PROXY_TEST_TIMEOUT_MS}MS`)), PROXY_TEST_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    return { ok: false, proxy: proxyUrl, ms: Date.now() - started, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
    request.catch(() => {});
  }

  const ms = Date.now() - started;
  const status = Number(resp?.status) || 0;
  if (status !== 200) {
    return {
      ok: false,
      proxy: proxyUrl,
      status,
      ms,
      error: status === 401 ? 'el proxy no respondió o rechazó (¿es SOCKS? usá socks5://)' : `HTTP_${status}`,
    };
  }
  try {
    return { ok: true, proxy: proxyUrl, status, ms, tokens: toItems(resp).length };
  } catch (err) {
    return { ok: false, proxy: proxyUrl, status, ms, error: String(err?.message || err) };
  }
}

// ── the tick ─────────────────────────────────────────────────────────────────

function evictOverCap() {
  while (Object.keys(trackTokens.getAll()).length > TRACK_TOKENS_MAX) {
    let oldest = null;
    for (const t of Object.values(trackTokens.getAll())) {
      if (!oldest || String(t.firstSeenAt) < String(oldest.firstSeenAt)) oldest = t;
    }
    if (!oldest) break;
    trackTokens.delete(oldest.address);
  }
}

async function trackTick() {
  try {
    if (Date.now() < backoffUntil) return;
    const config = getTrackConfig();
    if (!config.enabled) return;

    // Proxy + at least one filter, or there is nothing to do (the app's Track tab
    // says exactly what's missing).
    const gate = getTrackGate();
    if (!gate.ok) {
      if (!gateLogged) {
        gateLogged = true;
        const missing = [!gate.proxy.ok ? 'proxy' : null, !gate.filters.ok ? 'filtro' : null].filter(Boolean).join(' + ');
        console.log(`[track] en espera — falta configurar: ${missing}`);
      }
      return;
    }
    gateLogged = false;

    const attrs = await fetchGraduated();
    lastFetchAt = Date.now();
    lastError = null;

    const nowIso = new Date().toISOString();
    const byAddress = new Map();
    for (const a of attrs) {
      const address = a.tokenAddress || a.address;
      if (address) byAddress.set(address, a);
    }

    let changed = false; // structural events (enter / resume / identity / pause / cut)
    let snapshotted = false; // a token's stats series grew — its health (may) move

    // Extra sources (Pulse, Azura, FOMO thesis, GMGN chat, pump positions,
    // pump top-traders) for every token DUE a snapshot this tick, fetched all at
    // once: with 5-10 active tokens that's one parallel batch per minute (each
    // probed 20-parallel clean). The pump callout (~240KB) is fetched ONCE per
    // token — guarded by `tracked.callouts` and stored on the token itself,
    // since historical callouts don't change. Tokens that predate the field get
    // a per-tick backfill cap so ~90 × 240KB never fire in one parallel batch.
    // Done BEFORE the loop so the tick never waits inside the per-token iteration.
    const dueAddresses = [...byAddress.keys()].filter((address) => snapshotDue(trackTokens.get(address)));
    const extraByAddress = new Map();
    let backfillLeft = CALLOUT_BACKFILL_PER_TICK;
    await Promise.all(
      dueAddresses.map(async (address) => {
        const tracked0 = trackTokens.get(address);
        const isNew = (tracked0?.snapshots.length ?? 0) === 0;
        let wantCallout = !tracked0?.callouts;
        if (wantCallout && !isNew) {
          if (backfillLeft > 0) backfillLeft -= 1;
          else wantCallout = false;
        }
        // El chat es ACUMULATIVO: el acumulador viaja con el token y este fetch
        // lo alimenta (dedup por id) antes de que el loop lo vuelva a persistir.
        const chatAcc = tracked0?.chatAcc ?? { msgs: 0, seen: {}, wallets: {} };
        const [pulse, card, thesis, chat, callout, positions, top] = await Promise.all([
          fetchPulse(address),
          fetchAzura(address),
          fetchFomoThesis(address),
          fetchGmgnMessages(address, chatAcc),
          wantCallout ? fetchPumpCallout(address) : Promise.resolve(null),
          fetchPumpPositions(address),
          fetchPumpTopTraders(address),
        ]);
        extraByAddress.set(address, { pulse, card, thesis, chat, chatAcc, callout, positions, top });
      }),
    );

    for (const [address, a] of byAddress) {
      let tracked = trackTokens.get(address);
      // Persist only on structural changes (enter / resume / identity / snapshot):
      // at 1.3s cadence, lastSeenAt mutates memory every pull but rewriting the
      // whole store (up to 500 tokens × 50 snaps) 46x/min would be absurd.
      let persist = false;
      // Broadcast flag twin of persist: the snapshot cadence is steady (one per
      // minute per token), so counting it as "changed" would keep the full-list
      // push pinned to its fast throttle all session.
      let structural = false;
      if (!tracked) {
        // New in the (already Photon-filtered) column — no local re-check: what
        // Photon returns is what gets tracked, exactly like the Photon screen.
        tracked = {
          address,
          chain: 'sol',
          symbol: a.symbol ?? null,
          name: a.name ?? null,
          logo: a.imgUrl ?? null,
          status: 'active',
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          visible: true,
          snapshots: [],
        };
        persist = true;
        structural = true;
      } else {
        if (!tracked.visible) {
          tracked.visible = true; // resumed after a pause
          persist = true;
          structural = true;
        }
        tracked.lastSeenAt = nowIso;
        // The first sighting can miss the logo or the symbol.
        if (!tracked.symbol && a.symbol) { tracked.symbol = a.symbol; persist = true; structural = true; }
        if (!tracked.name && a.name) { tracked.name = a.name; persist = true; structural = true; }
        if (!tracked.logo && a.imgUrl) { tracked.logo = a.imgUrl; persist = true; structural = true; }
      }

      // One snapshot per minute, only while the track is still open (dense pulls
      // make the old tick-relative slack unnecessary — due lands within 1.3s).
      if (snapshotDue(tracked)) {
        const extra = extraByAddress.get(address) ?? {};
        if (extra.callout) tracked.callouts = extra.callout; // 1ª vez → queda en el token
        if (extra.chat) tracked.chatAcc = extra.chatAcc; // acumulador del chat acumulativo
        tracked.snapshots.push(
          snapshotOf(
            a, extra.pulse, extra.card, extra.thesis, extra.chat,
            tracked.callouts ?? null, extra.positions ?? null, extra.top ?? null,
          ),
        );
        persist = true;
        snapshotted = true;
        if (tracked.snapshots.length >= TRACK_SNAPSHOT_MAX) tracked.status = 'done'; // 50 → se corta
        const snapNow = tracked.snapshots[tracked.snapshots.length - 1];
        // ENTRADAS CAL100 (fuente 10): una wallet con callout ≥$100 que aparece
        // DESPUÉS de la línea base es un evento del token (minuto N). La fila nace
        // sin PnL y sweepCall100 la completa con 2 requests.
        if (detectCall100Entries(tracked, extra.positions?.call100Wallets, tracked.snapshots.length, snapNow.at)) {
          changed = true;
        }
        // Alertas de ENTRADA del Track (ver TRACK_ENTRY_CATEGORIES en notify.js):
        // se evalúan en el snapshot de entrada y se reintentan hasta el minuto
        // TRACK_ALERT_WINDOW si una fuente vino null. Una vez por token y
        // categoría — el seen-map de notify.js garantiza el "una sola vez"; esto
        // es el gancho.
        if (tracked.snapshots.length <= TRACK_ALERT_WINDOW) {
          const alertToken = {
            address,
            symbol: tracked.symbol,
            name: tracked.name,
            logo: tracked.logo,
            mcap: snapNow.mcap,
            volume: snapNow.volume,
            holders: snapNow.holders,
            chatWallets: snapNow.chatWallets,
            thesesCount: snapNow.thesesCount,
            topDaily: snapNow.topDaily,
            callout100to500: snapNow.callout100to500,
          };
          for (const category of TRACK_ENTRY_CATEGORIES) emitTrackEntry(category, alertToken);
        }
      }

      if (persist) {
        trackTokens.set(address, tracked);
        if (structural) changed = true;
      }
    }

    // Tracked tokens missing from this column: paused after a couple of misses —
    // at 1.3s pulls a single partial/reshuffled response must not flip the list.
    // Missing now also covers "stopped passing the track filters": the column is
    // filtered upstream, so a token that falls out of the range simply isn't
    // returned anymore. Data is kept; capture resumes on the next appearance. A
    // token that stays out for 30 continuous minutes is done for good (its run
    // ended), even if it never hit the snapshot cap — "paused forever" was never
    // a real state.
    for (const [address, tracked] of Object.entries(trackTokens.getAll())) {
      if (byAddress.has(address)) {
        missCount.delete(address);
        continue;
      }
      if (!tracked.visible) {
        // Already paused: check the 30-min cut against the last time it was seen.
        if (tracked.status === 'active' && Date.now() - Date.parse(tracked.lastSeenAt) >= TRACK_PAUSE_CUT_MS) {
          tracked.status = 'done';
          trackTokens.set(address, tracked);
          changed = true;
        }
        continue;
      }
      const misses = (missCount.get(address) ?? 0) + 1;
      missCount.set(address, misses);
      if (misses < TRACK_MISS_GRACE) continue;
      tracked.visible = false;
      missCount.delete(address);
      trackTokens.set(address, tracked);
      changed = true;
    }

    evictOverCap();
    if (changed) console.log(`[track] tick · ${byAddress.size} in column · ${Object.keys(trackTokens.getAll()).length} tracked`);
    maybeBroadcast(changed, snapshotted);
  } catch (err) {
    errorCount += 1;
    lastError = { message: String(err?.message || err), at: Date.now() };
    // A dead proxy fails fast — back off so 1.3s ticks don't hammer it (or the
    // log). The 429 path already set its longer rate-limit backoff.
    if (!err?.rateLimited) backoffUntil = Date.now() + ERROR_BACKOFF_MS;
    console.error('[track] tick failed:', lastError.message);
    // The error IS news for the tab — push it on the heartbeat's rhythm.
    maybeBroadcast(false);
  }
}

// One pull at a time: a slow proxy holds a tick for seconds, and the interval
// must not stack requests on top of it (same single-flight rule as photon.js).
function pollTick() {
  try {
    if (Date.now() < backoffUntil) return;
    if (trackInflight) return;
    trackInflight = trackTick().finally(() => {
      trackInflight = null;
    });
  } catch {
    /* the timer must never crash */
  }
}

export function startTrackPoller() {
  // A device that opens the Track tab subscribes and gets the current state on
  // the spot; from then on it is pushed, not polled.
  registerTopicProvider(TRACK_TOPIC, () => ({ event: 'track_updated', data: trackSnapshot() }));
  // Trade/FOMO/Photon subscribe to the chips-only topic — same instant snapshot.
  registerTopicProvider(TRACK_HEALTH_TOPIC, () => ({ event: 'track_health', data: { tokens: healthList() } }));
  if (poller) return;
  // A short delay so booting doesn't race Photon's own warm-up with a second
  // cold CycleTLS init.
  setTimeout(() => void trackTick(), 5_000);
  poller = setInterval(pollTick, PULL_MS);
  // Las ENTRADAS CAL100 (fuente 10) tienen su propio ritmo, aparte del tick: 2
  // requests por wallet (1d + 1w), 3 wallets en paralelo, y las filas nuevas se
  // resuelven sin tocar el camino del snapshot.
  call100Timer = setInterval(sweepCall100, CALL100_SWEEP_MS);
  console.log(
    `[track] poller started (col3 every ${PULL_MS}ms, 1 snap/${SNAPSHOT_MS / 1000}s per token, ≤${TRACK_SNAPSHOT_MAX} snaps/token, ≤${TRACK_TOKENS_MAX} tokens, CAL100 every ${CALL100_SWEEP_MS / 1000}s)`
  );
}

// ── reads (the HTTP surface) ─────────────────────────────────────────────────

export function getTrackStatus() {
  const all = Object.values(trackTokens.getAll());
  return {
    running: Boolean(poller),
    enabled: getTrackConfig().enabled,
    gate: getTrackGate(),
    // Two independent cadences: pulls detect presence/identity every PULL_MS;
    // snapshots (the stats series) stay at one per SNAPSHOT_MS per token.
    pullMs: PULL_MS,
    snapshotMs: SNAPSHOT_MS,
    // 30 continuous minutes out of the column end the run ("Cortado").
    pauseCutMs: TRACK_PAUSE_CUT_MS,
    snapshotMax: TRACK_SNAPSHOT_MAX,
    tokensMax: TRACK_TOKENS_MAX,
    lastFetchAt: lastFetchAt || null,
    fetchCount,
    errorCount,
    // Survives until the next successful tick clears it — a dead proxy has to
    // stay visible (a 10s freshness window against 60s ticks hid it forever).
    lastError,
    transport,
    proxy: { url: getTrackConfig().proxy },
    counts: {
      total: all.length,
      active: all.filter((t) => t.status === 'active').length,
      done: all.filter((t) => t.status === 'done').length,
      visible: all.filter((t) => t.visible).length,
    },
  };
}

// ── live push (WS topic `track`) ─────────────────────────────────────────────

/**
 * The payload the Track tab paints — identical to GET /api/track, so the phone
 * runs the same merge whether the state arrived by poll or by push.
 */
export function trackSnapshot() {
  return { config: getTrackConfig(), status: getTrackStatus(), tokens: listTrackTokens() };
}

const TRACK_TOPIC = 'track';
// Trade/FOMO/Photon paint only the health chip, and they stay subscribed while
// those tabs are open — a ~30-byte-per-token payload is what makes that cheap,
// instead of riding the full list on every push.
const TRACK_HEALTH_TOPIC = 'track:health';
// The tracker mutates every 1.3s (presence) and every 60s (snapshots): pushing
// every change would spam the phone for a list it repaints in one go anyway.
const BROADCAST_MIN_MS = 2_000;
// The snapshot flow is steady (one per minute per token): on that rhythm the
// full list waits a beat — the tabs care about counts and chips, not each minute.
const BROADCAST_DATA_MS = 15_000;
// Silence is not freshness — with nothing moving, say so every 30s anyway, so
// lastFetchAt / errors / gate changes still reach the tab without a poll.
const BROADCAST_HEARTBEAT_MS = 30_000;

let lastBroadcastAt = 0;
let lastHealthBroadcastAt = 0;

/** The light payload behind the chips: address + health + buy, nothing else. */
const healthList = () =>
  listTrackTokens().map((t) => ({
    address: t.address,
    health: t.health,
    buySignal: t.buySignal,
    strongBuy: t.strongBuy,
    watchSignal: t.watchSignal,
  }));

/**
 * Push to whoever is watching. Nobody subscribed → not even serialized. Two
 * rhythms per topic: structural events (enter/pause/cut) ride the fast lane,
 * the snapshot flow the slow one, and silence only pushes on the heartbeat.
 */
function maybeBroadcast(changed, snapshotted = false) {
  const now = Date.now();
  const fullDue = changed ? BROADCAST_MIN_MS : snapshotted ? BROADCAST_DATA_MS : BROADCAST_HEARTBEAT_MS;
  if (getSubscriptions().has(TRACK_TOPIC) && now - lastBroadcastAt >= fullDue) {
    lastBroadcastAt = now;
    broadcast(TRACK_TOPIC, { event: 'track_updated', data: trackSnapshot() });
  }
  // Chips move WITH the snapshots (health reads the series), so they take the
  // fast lane as soon as any series grew.
  const healthDue = changed || snapshotted ? BROADCAST_MIN_MS : BROADCAST_HEARTBEAT_MS;
  if (getSubscriptions().has(TRACK_HEALTH_TOPIC) && now - lastHealthBroadcastAt >= healthDue) {
    lastHealthBroadcastAt = now;
    broadcast(TRACK_HEALTH_TOPIC, { event: 'track_health', data: { tokens: healthList() } });
  }
}

/**
 * Health pill for one token — derived from its OWN snapshot series (nothing
 * extra to persist). Signals, in order of measured strength on ~130 tracked
 * tokens: holders growth (r=0.82 vs final return), net buying, drawdown,
 * turnover (vol/mcap — ≥10x means distribution: 0% of those doubled, median
 * −67%) and bundle collapse (insiders dumping, −22pts on the dead vs +1 on
 * the winners). Also: 3 consecutive up minutes early = 83% chance of doubling.
 *   green  holders ≥ +10% first→last AND buys ≥ sells AND above entry, with
 *          turnover < 8x and no bundle dump — or 3+ up minutes with buying
 *   red    holders ≤ −10%, or shrinking under selling pressure, or down ≥ −50%
 *          from the tracked peak, or turnover ≥ 10x, or bundle collapsing ≤ −10
 *   amber  mixed signals — null until there are 2 snapshots to judge
 */
export function trackHealth(snaps) {
  if (!Array.isArray(snaps) || snaps.length < 2) return { health: null, holdersDeltaPct: null, flowRatio: null, turnover: null };
  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  const holdersDeltaPct =
    first.holders != null && last.holders != null && first.holders > 0
      ? ((last.holders - first.holders) / first.holders) * 100
      : null;
  // buys/sells are cumulative: a window's flow is the delta across it (~3 min
  // when the series is long enough, so one noisy minute can't flip the chip).
  const prev = snaps[Math.max(0, snaps.length - 4)];
  let flowRatio = null;
  if (last.buys != null && last.sells != null && prev.buys != null && prev.sells != null) {
    const dBuys = last.buys - prev.buys;
    const dSells = last.sells - prev.sells;
    if (dSells > 0) flowRatio = dBuys / dSells;
    else if (dBuys > 0) flowRatio = 99; // window with no sellers at all
    else if (last.sells > 0) flowRatio = last.buys / last.sells; // flat window → lifetime ratio
  }
  // Drawdown from the tracked peak — a run that gave back half is broken even
  // if holders still look fine on paper.
  let peak = null;
  for (const s of snaps) if (s.mcap != null && (peak == null || s.mcap > peak)) peak = s.mcap;
  const drawdownPct = peak != null && last.mcap != null ? (last.mcap / peak - 1) * 100 : null;
  // Return vs the FIRST tracked mcap — green must not sit below its entry.
  const entryReturnPct = first.mcap != null && last.mcap != null && first.mcap > 0 ? (last.mcap / first.mcap - 1) * 100 : null;
  // Turnover NOW (volume ÷ mcap): healthy = a few x; ≥10x = they are exiting
  // into the volume (0% of tracked tokens with ≥10x ended above entry).
  const turnover = last.mcap > 0 ? numOrNull(last.volume) != null ? last.volume / last.mcap : null : null;
  // Bundle delta over the window: insiders dumping shows here first (the dead
  // lost ~22 pts of bundled supply while the winners stayed flat).
  const bundleDeltaPct =
    numOrNull(last.bundlePct) != null && numOrNull(prev.bundlePct) != null ? last.bundlePct - prev.bundlePct : null;
  // Momentum: consecutive latest snapshots each above the previous. 3+ up
  // minutes early was the single strongest pattern (83% doubled, n=12).
  let upStreak = 0;
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i].mcap != null && snaps[i - 1].mcap != null && snaps[i].mcap > snaps[i - 1].mcap) upStreak++;
    else break;
  }

  let health = 'amber';
  if (
    (holdersDeltaPct != null && holdersDeltaPct <= -10) ||
    (holdersDeltaPct != null && holdersDeltaPct < 0 && (flowRatio == null || flowRatio < 1)) ||
    (drawdownPct != null && drawdownPct <= -50) ||
    (turnover != null && turnover >= 10) ||
    (bundleDeltaPct != null && bundleDeltaPct <= -10)
  ) {
    health = 'red';
  } else if (
    (holdersDeltaPct != null &&
      holdersDeltaPct >= 10 &&
      flowRatio != null &&
      flowRatio >= 1 &&
      (entryReturnPct == null || entryReturnPct >= -10)) ||
    (upStreak >= 3 && flowRatio != null && flowRatio >= 1)
  ) {
    // The holders+-but-dying trap: high turnover or an insider dump downgrades
    // green to amber even when the other signals look fine.
    health = (turnover != null && turnover >= 8) || (bundleDeltaPct != null && bundleDeltaPct <= -5) ? 'amber' : 'green';
  }
  return { health, holdersDeltaPct, flowRatio, turnover };
}

/**
 * Bundle growth from entry (first snapshot) to minute 3 — the measured
 * insider-accretion gauge, always over the same validated 0→3 window so the
 * verdict never drifts as the track runs longer. Winners enter with the
 * bundle QUIET (<1.4x growth); the ones whose bundled wallets multiply in
 * minutes die (0 of 25 that grew ≥1.5x ended above; AUC 0.06, the strongest
 * separator ever measured here). Null when either endpoint is missing.
 */
function bundleQuietRatio(snaps) {
  const first = numOrNull(snaps[0]?.bundleHolders);
  const third = numOrNull(snaps[2]?.bundleHolders);
  if (first == null || first <= 0 || third == null) return null;
  return third / first;
}

/**
 * The BUY signal — the one number to answer "¿compro?" — computed from the
 * snapshot series the same prefix-safe way as the health chip (each minute
 * reads only [0..i], so the timeline shows the live signal, never hindsight).
 *
 * Validated on 147 finished tracks (entry measured at the minute-3 price, the
 * earliest a human can act on it — NOT the min-0 price, which inflates
 * everything): the profile below ended +29% median / 62% positive vs −34% /
 * 26% for the rest. The measured separators, winners vs traps:
 *   · bots (tpHolders) < 150   the STRONGEST separator there is
 *   · holders < 300            winners enter into a smaller crowd
 *   · snipers < 1%             no sniper swarm waiting to dump, when the value
 *     is reported. A MISSING value neither passes for free (that relaxation
 *     halved the precision, 62% → 50%) nor kills the signal (37% of tokens
 *     never report it): it must be backed by a QUIET BUNDLE instead — bundle
 *     growth <1.4x. That substitute recovered the coverage at full precision
 *     (19 signals, 63% positive, +28% median).
 *   · mcap up at minute 3      momentum confirmed, not hoped
 * 'buy' needs all four; 'avoid' is the explicit fail of the entry profile (a
 * token that fails it ended below 74% of the time); null until there are 3
 * snapshots to judge — no data, no signal, never a guess.
 */
export function trackBuySignal(snaps) {
  if (!Array.isArray(snaps) || snaps.length < 3) return null;
  const first = snaps[0];
  const third = snaps[2];
  if (numOrNull(first.tpHolders) == null || numOrNull(first.holders) == null) return null;
  const snipersOk =
    numOrNull(first.snipersPct) != null
      ? first.snipersPct < BUY_MAX_SNIPERS_PCT
      : (bundleQuietRatio(snaps) ?? Infinity) < BUY_MAX_QUIET_RATIO;
  const profile = first.tpHolders < BUY_MAX_TP_HOLDERS && first.holders < BUY_MAX_HOLDERS && snipersOk;
  if (!profile) return 'avoid';
  // Momentum is what turns the profile into a signal: the profile alone still
  // needs the first move to confirm — buying a quiet profile is timing luck.
  if (numOrNull(first.mcap) == null || numOrNull(third.mcap) == null) return null;
  return third.mcap > first.mcap ? 'buy' : null;
}

/**
 * COMPRAR FUERTE — the buy signal PLUS a bundle that stayed quiet (<1.4x).
 * The intersection measured 75% positive / +109% median / +236% peak from the
 * minute-3 price, the strongest cell in the dataset — flagged experimental on
 * purpose: the sample is still n=4, so the label stays until more tokens
 * confirm it. Never true without the buy signal underneath.
 */
export function trackStrongBuy(snaps) {
  if (trackBuySignal(snaps) !== 'buy') return false;
  const ratio = bundleQuietRatio(snaps);
  return ratio != null && ratio < BUY_MAX_QUIET_RATIO;
}

/**
 * WATCH (chip B) — the group the entry profile REJECTS but that looks alive:
 * health green + bundle quiet (<1.4x) and not already COMPRAR. Informational
 * only, no alert: measured 50% positive / +6% median, but +106% median PEAK —
 * 5 of 10 touched +100% (Bear +331%, sanctuary +28%/pico +1039%), so it only
 * makes sense WITH a TP/SL discipline (median TP/SL outcome +100%). The
 * profile's holders/bots limits stay enforced for the buy signal: the same
 * group without the quiet bundle loses 83% of the time.
 */
export function trackWatchSignal(snaps) {
  if (trackBuySignal(snaps) === 'buy') return false;
  if (trackHealth(snaps).health !== 'green') return false;
  const ratio = bundleQuietRatio(snaps);
  return ratio != null && ratio < BUY_MAX_QUIET_RATIO;
}

/**
 * Snapshots with the chip as it looked AT THAT MINUTE — each computed from the
 * prefix [0..i] only, so the timeline shows the live signal, never hindsight.
 * The first snapshot carries no chip (nothing to compare against yet).
 */
export function snapshotsWithHealth(snaps) {
  const series = Array.isArray(snaps) ? snaps : [];
  return series.map((s, i) => {
    const prefix = series.slice(0, i + 1);
    const h = trackHealth(prefix);
    return {
      ...s,
      health: h.health,
      turnover: h.turnover,
      buySignal: trackBuySignal(prefix),
      strongBuy: trackStrongBuy(prefix),
      watchSignal: trackWatchSignal(prefix),
    };
  });
}

/** Summary fields for one tracked token (the list row + the detail's header). */
export function summarizeTrackToken(t) {
  const snaps = Array.isArray(t.snapshots) ? t.snapshots : [];
  const last = snaps[snaps.length - 1];
  const firstMcap = snaps[0]?.mcap ?? null;
  let maxMcap = null;
  for (const s of snaps) if (s.mcap != null && (maxMcap == null || s.mcap > maxMcap)) maxMcap = s.mcap;
  return {
    address: t.address,
    chain: t.chain ?? 'sol',
    symbol: t.symbol ?? null,
    name: t.name ?? null,
    logo: t.logo ?? null,
    status: t.status,
    firstSeenAt: t.firstSeenAt,
    lastSeenAt: t.lastSeenAt,
    visible: Boolean(t.visible),
    snapshotCount: snaps.length,
    // the row's "MC / VOL" line comes from the newest snapshot
    mcap: last?.mcap ?? null,
    volume: last?.volume ?? null,
    // first snapshot → the highest seen: how far it pumped while tracked
    maxMcap,
    gainPct: firstMcap && maxMcap != null ? (maxMcap / firstMcap - 1) * 100 : null,
    // the health chip: green / amber / red (null < 2 snapshots)
    ...trackHealth(snaps),
    // the buy signal: 'buy' / 'avoid' / null (needs the first 3 minutes)
    buySignal: trackBuySignal(snaps),
    // buy + bundle quieto — la celda más fuerte del dataset (experimental, n=4)
    strongBuy: trackStrongBuy(snaps),
    // chip B: verde + bundle quieto sin llegar a buy — informativo, con TP/SL
    watchSignal: trackWatchSignal(snaps),
    // Latest Pulse + Azura readings (newest snapshot) — the detail's extra
    // chips. null on tokens tracked before those sources existed.
    smartTraderPct: last?.smartTraderPct ?? null,
    proTraders: last?.proTraders ?? null,
    creatorMints: last?.creatorMints ?? null,
    creatorGraduated: last?.creatorGraduated ?? null,
    overallSecurity: last?.overallSecurity ?? null,
    securityFlags: last?.securityFlags ?? null,
    volChange1h: last?.volChange1h ?? null,
    buyVol5m: last?.buyVol5m ?? null,
    sellVol5m: last?.sellVol5m ?? null,
    buyVol1h: last?.buyVol1h ?? null,
    sellVol1h: last?.sellVol1h ?? null,
    // Últimas lecturas sociales (fuentes 4-6) — la lista no las pinta, el
    // detalle las sirve junto a los snapshots.
    thesesCount: last?.thesesCount ?? null,
    thesesOpen: last?.thesesOpen ?? null,
    thesesUsd: last?.thesesUsd ?? null,
    thesesPnlAvg: last?.thesesPnlAvg ?? null,
    thesesEntryMcap: last?.thesesEntryMcap ?? null,
    chatMsgs: last?.chatMsgs ?? null,
    chatWallets: last?.chatWallets ?? null,
    chatHoldersUsd: last?.chatHoldersUsd ?? null,
    chatPnlAvg: last?.chatPnlAvg ?? null,
    chatKols: last?.chatKols ?? null,
    calloutsTotal: last?.calloutsTotal ?? null,
    calloutsUsd: last?.calloutsUsd ?? null,
    calloutsUpPct: last?.calloutsUpPct ?? null,
    calloutsEntryMcap: last?.calloutsEntryMcap ?? null,
    calloutsVerified: last?.calloutsVerified ?? null,
    posHolders: last?.posHolders ?? null,
    posHoldersTotal: last?.posHoldersTotal ?? null,
    callout100: last?.callout100 ?? null,
    calloutLt100: last?.calloutLt100 ?? null,
    callout100to500: last?.callout100to500 ?? null,
    callout500: last?.callout500 ?? null,
    topDaily: last?.topDaily ?? null,
    topWeekly: last?.topWeekly ?? null,
    topMonthly: last?.topMonthly ?? null,
    topTraderNames: last?.topTraderNames ?? null,
  };
}

/** Summaries without snapshots (the list); newest activity first. */
export function listTrackTokens() {
  return Object.values(trackTokens.getAll())
    .map(summarizeTrackToken)
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
}

/** One tracked token with its full snapshot series (the detail view / analysis). */
export function getTrackToken(address) {
  const t = trackTokens.get(String(address ?? '').toLowerCase()) ?? trackTokens.get(String(address ?? ''));
  return t ?? null;
}

export function clearTrack() {
  for (const key of Object.keys(trackTokens.getAll())) trackTokens.delete(key);
  return { cleared: true };
}
