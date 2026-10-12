/**
 * HTTP API — the app's control plane over the live feeds.
 *
 *   GET  /api/health
 *   GET  /api/status                        feed health + WS clients
 *   GET  /api/fomo/{graduated,trending}     HTTP fallback of each feed (WS is primary)
 *   GET  /api/fomo/filters                  effective filters per feed
 *   PUT  /api/fomo/filters                  { graduated: {...}, trending: {...} }
 *   GET  /api/market/memescope              Photon columns (Cold-startable)
 *   GET  /api/market/memescope-filters
 *   PUT  /api/market/memescope-filters      { col1: {...}, col3: {...} }
 *   GET  /api/notifications/config          this device's config
 *   PUT  /api/notifications/config          register device + categories
 *   DELETE /api/notifications/config        unregister
 *   GET  /api/notifications/history         alert history for this device
 *   POST /api/notifications/test            fire a test alert (panel + push)
 *   GET  /api/track                         tracked tokens (summary) + config + status
 *   GET  /api/track/export                  everything WITH snapshots (analysis)
 *   GET  /api/track/config · PUT            the tracker's own filter set
 *   POST /api/track/proxy-test              prove a proxy with one real fetch
 *   GET  /api/track/:address                one tracked token + its snapshots
 *   DELETE /api/track                       clear every tracked token
 */

import { Router } from 'express';

import { getFomoGraduated, getFomoProxyStatus, getFomoStatus, getFomoTrending, setFomoProxy } from './fomo.js';
import { getFomoFilters, setFomoFilters } from './fomo-filter-store.js';
import { getMemescope, getMemescopeStatus, getPhotonFilters, setPhotonFilters } from './photon.js';
import { photonLogo } from './logo-proxy.js';
import { clearTrack, getTrackConfig, getTrackStatus, getTrackToken, listTrackTokens, setTrackConfig, snapshotsWithHealth, summarizeTrackToken, testTrackProxy, TRACK_SNAPSHOT_MAX, TRACK_TOKENS_MAX } from './track.js';
import { notificationConfig, notificationHistory } from './stores.js';
import { getPushReceipt, isValidPushToken, sendPush } from './push.js';
import { sendToDevice } from './ws.js';
import { clientCount, getSubscriptions } from './ws.js';

const router = Router();

const CATEGORIES = ['fomo_graduated', 'fomo_trending', 'photon_new', 'photon_graduated'];

function deviceId(req) {
  const id = req.headers['x-device-id'] || req.query.deviceId;
  if (!id || typeof id !== 'string' || id.length > 128) {
    throw Object.assign(new Error('Missing or invalid X-Device-Id'), { status: 400 });
  }
  return id;
}

const fail = (res, err) => res.status(err?.status || 500).json({ error: err?.message || 'Internal error' });

router.get('/health', (_req, res) =>
  // dataDir lets the app (and we) confirm the server writes to a persistent
  // volume — on Railway it must be /data or every redeploy wipes the stores.
  // uptime lets an external check detect when a redeploy actually happened.
  res.json({
    ok: true,
    time: new Date().toISOString(),
    dataDir: process.env.DATA_DIR || 'data/',
    uptime: Math.round(process.uptime()),
  })
);

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    ws: { clients: clientCount(), topics: [...getSubscriptions()] },
    fomo: getFomoStatus(),
    photon: getMemescopeStatus(),
  });
});

// ── FOMO ─────────────────────────────────────────────────────────────────────

router.get('/fomo/proxy', (_req, res) => {
  try {
    res.json(getFomoProxyStatus());
  } catch (err) {
    fail(res, err);
  }
});

router.put('/fomo/proxy', (req, res) => {
  try {
    // Shared egress for FOMO + Photon. Body { url, enabled? }: '' clears the URL;
    // `enabled` flips the Settings switch without losing a saved one. Omitting it
    // keeps the historical behavior (a landed URL counts as on).
    res.json(setFomoProxy(req.body?.url ?? '', req.body?.enabled));
  } catch (err) {
    res.status(400).json({ error: err?.message || 'proxy inválido' });
  }
});

router.get('/fomo/filters', (_req, res) => res.json(getFomoFilters()));

router.put('/fomo/filters', (req, res) => {
  try {
    res.json(setFomoFilters(req.body ?? {}));
  } catch (err) {
    fail(res, err);
  }
});

router.get('/fomo/graduated', async (req, res) => {
  try {
    res.json(await getFomoGraduated(req.query ?? {}));
  } catch (err) {
    fail(res, err);
  }
});

router.get('/fomo/trending', async (req, res) => {
  try {
    res.json(await getFomoTrending(req.query ?? {}));
  } catch (err) {
    fail(res, err);
  }
});

// ── Photon ───────────────────────────────────────────────────────────────────

// Photon token images (host blocks hotlinking; the server re-serves them).
router.get('/photon/logo', photonLogo);

router.get('/market/memescope', async (_req, res) => {  try {
    res.json(await getMemescope());
  } catch (err) {
    fail(res, err);
  }
});

router.get('/market/memescope-filters', (_req, res) => res.json(getPhotonFilters()));

router.put('/market/memescope-filters', (req, res) => {
  try {
    res.json(setPhotonFilters(req.body ?? {}));
  } catch (err) {
    fail(res, err);
  }
});

// ── Notifications ────────────────────────────────────────────────────────────

router.get('/notifications/config', (req, res) => {
  try {
    const id = deviceId(req);
    const entry = notificationConfig.get(id);
    if (!entry) return res.json({ device_id: id, registered: false, has_push: false });
    // has_push is the app's diagnostic: without a stored token pushes can't reach the
    // device no matter what (the floating panel still works over its private WS topic).
    res.json({
      device_id: id,
      registered: true,
      has_push: isValidPushToken(entry.push_token),
      categories: entry.categories,
    });
  } catch (err) {
    fail(res, err);
  }
});

router.put('/notifications/config', (req, res) => {
  try {
    const id = deviceId(req);
    const { push_token, categories } = req.body ?? {};
    // A device without a push token is panel-only: it still receives alerts over its private
    // WS topic (Expo Go can't do remote push since SDK 53, but the in-app panel works).
    const hasPush = isValidPushToken(push_token);
    if (push_token && !hasPush) throw Object.assign(new Error('Invalid Expo push token'), { status: 400 });

    const cats = {};
    for (const key of CATEGORIES) cats[key] = Boolean(categories?.[key]);

    // No filters here on purpose: the feed screens own them (FOMO pushes both tabs,
    // Photon its columns) and notify.js gates the alerts with those — this config only
    // says which categories the device wants. Any `filters` an older client still sends
    // are dropped with the entry rewrite below.
    const entry = {
      device_id: id,
      push_token: hasPush ? push_token : null,
      categories: cats,
      updated_at: new Date().toISOString(),
    };
    notificationConfig.set(id, entry);
    res.json({ ok: true, config: entry });
  } catch (err) {
    fail(res, err);
  }
});

router.delete('/notifications/config', (req, res) => {
  try {
    const id = deviceId(req);
    notificationConfig.delete(id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/notifications/history', (req, res) => {
  try {
    const id = deviceId(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const items = notificationHistory
      .filter((e) => e.device_id === id)
      .sort((a, b) => String(b.notified_at).localeCompare(String(a.notified_at)))
      .slice(0, limit);
    res.json({ items });
  } catch (err) {
    fail(res, err);
  }
});

/** Fires a synthetic alert through the exact same path a real one takes. */
router.post('/notifications/test', async (req, res) => {
  try {
    const id = deviceId(req);
    const device = notificationConfig.get(id);
    if (!device) throw Object.assign(new Error('Device not registered'), { status: 404 });
    const entry = notificationHistory.add({
      device_id: id,
      category: req.body?.category || 'fomo_graduated',
      address: 'TESTTESTTESTTESTTESTTESTTESTTESTTEST',
      chain: 'sol',
      symbol: 'TEST',
      name: 'Token de prueba',
      logo: null,
      mcap: 42_000,
      liq: 12_000,
      vol24h: 3_400,
      holders: 120,
      kolCount: 1,
      ageMinutes: 5,
      notified_at: new Date().toISOString(),
    });
    sendToDevice(id, { event: 'alert', data: entry });
    if (!isValidPushToken(device.push_token)) {
      // The most common "push never arrives": this device never stored a token.
      return res.json({ ok: true, entry, push: { sent: false, reason: 'no_token' } });
    }
    let push;
    try {
      const { ticketId, result } = await sendPush(device.push_token, {
        title: 'TEST — Paper Terminal',
        body: 'Así se ve una alerta.',
        data: { test: true },
      });
      const ticket = result?.data ?? null;
      // A ticket only means Expo accepted the message; the receipt is the real delivery
      // verdict from FCM (credential / registration failures surface there). Poll
      // briefly — receipts usually land within a second or two.
      let receipt = null;
      if (ticket?.status === 'ok' && ticketId) {
        for (let i = 0; i < 3 && !receipt; i += 1) {
          await new Promise((r) => setTimeout(r, 1300));
          receipt = await getPushReceipt(ticketId).catch(() => null);
        }
      }
      push = { sent: true, ticket, receipt };
    } catch (err) {
      push = { sent: false, reason: `expo_unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
    res.json({ ok: true, entry, push });
  } catch (err) {
    fail(res, err);
  }
});

// ── Track ────────────────────────────────────────────────────────────────────

// Summary list + config + health in one call (what the app's Track tab loads).
router.get('/track', (_req, res) => {
  try {
    res.json({ config: getTrackConfig(), status: getTrackStatus(), tokens: listTrackTokens() });
  } catch (err) {
    fail(res, err);
  }
});

// Everything WITH snapshots — the analysis dump the user asked for.
router.get('/track/export', (_req, res) => {
  try {
    res.json({
      config: getTrackConfig(),
      status: getTrackStatus(),
      snapshotMax: TRACK_SNAPSHOT_MAX,
      tokensMax: TRACK_TOKENS_MAX,
      tokens: listTrackTokens().map((s) => ({ ...s, snapshots: snapshotsWithHealth(getTrackToken(s.address)?.snapshots ?? []) })),
    });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/track/config', (_req, res) => res.json(getTrackConfig()));

router.put('/track/config', (req, res) => {
  try {
    res.json(setTrackConfig(req.body ?? {}));
  } catch (err) {
    fail(res, err);
  }
});

// Test a (possibly unsaved) proxy with one real fetch — never throws.
router.post('/track/proxy-test', async (req, res) => {
  res.json(await testTrackProxy(req.body?.proxy));
});

router.get('/track/:address', (req, res) => {
  const token = getTrackToken(req.params.address);
  if (!token) return res.status(404).json({ error: 'Token no trackeado' });
  // Summary (incl. the health chip) + the series, each snapshot tagged with
  // the chip it showed AT THAT MINUTE (prefix series — no hindsight).
  res.json({ ...summarizeTrackToken(token), snapshots: snapshotsWithHealth(token.snapshots) });
});

router.delete('/track', (_req, res) => {
  try {
    res.json(clearTrack());
  } catch (err) {
    fail(res, err);
  }
});

export default router;
