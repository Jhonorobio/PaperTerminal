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
 *   PUT  /api/notifications/config          register device + categories + filters
 *   DELETE /api/notifications/config        unregister
 *   GET  /api/notifications/history         alert history for this device
 *   POST /api/notifications/test            fire a test alert (panel + push)
 */

import { Router } from 'express';

import { getFomoFilters, getFomoGraduated, getFomoProxyStatus, getFomoStatus, getFomoTrending, setFomoFilters, setFomoProxy } from './fomo.js';
import { getMemescope, getMemescopeStatus, getPhotonFilters, setPhotonFilters } from './photon.js';
import { photonLogo } from './logo-proxy.js';
import { notificationConfig, notificationHistory } from './stores.js';
import { isValidPushToken, sendPush } from './push.js';
import { sendToDevice } from './ws.js';
import { clientCount, getSubscriptions } from './ws.js';
import { sanitizeAlertFilters } from './notify.js';

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

router.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

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
    // Body { url: '' } clears it (direct connection).
    res.json(setFomoProxy(req.body?.url ?? ''));
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
    if (!entry) return res.json({ device_id: id, registered: false });
    res.json({ ...entry, registered: true });
  } catch (err) {
    fail(res, err);
  }
});

router.put('/notifications/config', (req, res) => {
  try {
    const id = deviceId(req);
    const { push_token, categories, filters } = req.body ?? {};
    // A device without a push token is panel-only: it still receives alerts over its private
    // WS topic (Expo Go can't do remote push since SDK 53, but the in-app panel works).
    const hasPush = isValidPushToken(push_token);
    if (push_token && !hasPush) throw Object.assign(new Error('Invalid Expo push token'), { status: 400 });

    const cats = {};
    for (const key of CATEGORIES) cats[key] = Boolean(categories?.[key]);

    const existing = notificationConfig.get(id);
    const cleanFilters = sanitizeAlertFilters(filters);
    // Categories turned off drop their filters (same rule as the original server).
    for (const key of CATEGORIES) if (!cats[key]) delete cleanFilters[key];

    const entry = {
      device_id: id,
      push_token: hasPush ? push_token : null,
      categories: cats,
      filters: { ...(existing?.filters ?? {}), ...cleanFilters },
      updated_at: new Date().toISOString(),
    };
    for (const key of CATEGORIES) if (!cats[key]) delete entry.filters[key];
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
    if (isValidPushToken(device.push_token)) {
      void sendPush(device.push_token, { title: 'TEST — Paper Terminal', body: 'Así se ve una alerta.', data: { test: true } }).catch(() => {});
    }
    res.json({ ok: true, entry });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
