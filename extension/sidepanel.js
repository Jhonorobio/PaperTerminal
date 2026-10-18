/**
 * Paper Terminal — Monitor · side panel
 *
 * Dos cosas, nada más:
 *   1. Las ALERTAS de este dispositivo (historial por HTTP + el push en vivo que el
 *      service worker recibe y reenvía), configuradas con las mismas categorías y
 *      umbrales por dispositivo que la app.
 *   2. El TRACK: la lista del tracker en vivo (topic `track`) y el detalle minuto a
 *      minuto de un token (HTTP).
 *
 * Los tableros de FOMO, Photon y Pump Trend. NO están acá a propósito: los filtros de
 * esos feeds viven en el teléfono (se aplican localmente por dispositivo), así que un
 * espejo en el navegador mostraría otra cosa. Sus alertas, en cambio, sí están: llegan
 * del server y se configuran en Ajustes como cualquier otra.
 */

import {
  ALERT_CATEGORIES,
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  DEFAULT_ALERT_PARAMS,
  DEFAULT_CATEGORIES,
  DEFAULT_SERVER,
  TOPICS,
  apiCall,
  categoryGroup,
  clockOf,
  compactUsd,
  formatError,
  getSettings,
  originOf,
  shortAddr,
  signedPct,
  timeAgo,
  toWsUrl,
} from './shared.js';

const PING_MS = 20_000;
const RECONNECT_MS = 5_000;
const RENDER_THROTTLE_MS = 700;
const SNAPSHOT_ROWS = 25;

const state = {
  tab: 'alerts',
  serverBase: DEFAULT_SERVER,
  deviceId: '',
  categories: { ...DEFAULT_CATEGORIES },
  params: { ...DEFAULT_ALERT_PARAMS },
  notificationsOn: true,
  feeds: { connected: false, error: null },
  alertsConnected: false,
  track: null,
  trackAt: 0,
  alerts: [],
  alertFilter: 'all',
  query: '',
  onlyActive: true,
  problem: null,
  notice: null,
  syncError: null,
  detail: null,
};

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'onclick') node.addEventListener('click', value);
    else if (key === 'oninput') node.addEventListener('input', value);
    else if (key === 'onchange') node.addEventListener('change', value);
    else if (key === 'checked' || key === 'disabled' || key === 'value') node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

const chip = (text, tone) => el('span', { class: `chip${tone ? ` ${tone}` : ''}`, text });

/** Un número (o un texto ya formateado como "12.3%") con su etiqueta — el vocabulario de IDs/chips. */
const chipNum = (label, value, tone) => {
  if (value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return null;
  return chip(`${label} ${value}`, tone);
};

function toneOfHealth(health) {
  return health === 'green' ? 'green' : health === 'red' ? 'red' : health === 'amber' ? 'amber' : null;
}

/** Fila de token: main (símbolo + sub + chips + nota) · lado derecho (mcap y extra). */
function tokenRow({ symbol, sub, chips = [], side = [], tone, onClick, title, note }) {
  return el('div', { class: 'row', onclick: onClick, title }, [
    el('div', { class: 'row-main' }, [
      el('div', { class: 'row-top' }, [
        el('span', { class: `sym${tone ? ` ${tone}` : ''}`, text: symbol || '—' }),
        sub ? el('span', { class: 'sub', text: sub }) : null,
      ]),
      chips.filter(Boolean).length ? el('div', { class: 'chips' }, chips.filter(Boolean)) : null,
      // Línea suelta para lo que no entra en chips (hoy: el detalle de la entrada
      // CAL100+ que arma el server en `body`).
      note ? el('span', { class: 'row-note', text: note }) : null,
    ]),
    el('div', { class: 'row-side' }, side.filter(Boolean)),
  ]);
}

// ── WebSocket del Track ───────────────────────────────────────────────────────

let socket = null;
let pingTimer = null;
let reconnectTimer = null;
let renderTimer = null;
let renderScope = null;

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      /* onclose se encarga */
    }
  }
}

function connectFeeds() {
  if (pingTimer) clearInterval(pingTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ya estaba */
    }
  }
  pingTimer = null;
  reconnectTimer = null;

  let next;
  try {
    next = new WebSocket(toWsUrl(state.serverBase));
  } catch (err) {
    state.feeds = { connected: false, error: formatError(err) };
    scheduleRender('all');
    return;
  }
  socket = next;

  next.onopen = () => {
    state.feeds = { connected: true, error: null };
    send({ action: 'subscribe', topic: TOPICS.track });
    pingTimer = setInterval(() => send({ action: 'ping' }), PING_MS);
    scheduleRender('all');
  };

  next.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (msg.event === 'pong' || msg.event === 'connected') return;
    if (msg.topic === TOPICS.track) {
      state.track = msg.data ?? null;
      state.trackAt = Date.now();
      scheduleRender('track');
    }
  };

  next.onclose = () => {
    if (socket === next) socket = null;
    state.feeds = { connected: false, error: state.feeds.error };
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    scheduleRender('all');
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectFeeds();
      }, RECONNECT_MS);
    }
  };

  next.onerror = () => {
    state.feeds.error = 'no se pudo conectar al server';
  };
}

/** Un frame del tracker llega seguido: renderizamos con techo, no por frame. */
function scheduleRender(scope) {
  renderScope = scope;
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (renderScope === 'all' || renderScope === state.tab) render();
  }, RENDER_THROTTLE_MS);
}

// ── service worker (alertas) ──────────────────────────────────────────────────

async function sw(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...payload });
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'alert' && message.entry) {
    pushAlert(message.entry);
  } else if (message?.type === 'status') {
    state.alertsConnected = Boolean(message.connected);
    scheduleRender('all');
  } else if (message?.type === 'focus-address') {
    void openTrackDetail(message.address, message.symbol);
  }
});

function pushAlert(entry) {
  if (!entry?.id) return;
  if (state.alerts.some((a) => a.id === entry.id)) return;
  state.alerts = [entry, ...state.alerts].slice(0, 300);
  updateCounts();
  if (state.tab === 'alerts') scheduleRender('alerts');
}

async function refreshHistory() {
  try {
    const data = await apiCall(state.serverBase, '/api/notifications/history?limit=100');
    const items = Array.isArray(data.items) ? data.items : [];
    // El historial manda el orden; las que llegaron en vivo y ya no están en la
    // respuesta se quedan (el server recorta a 500, nosotros a 300).
    const byId = new Map();
    for (const item of [...state.alerts, ...items]) if (item?.id != null) byId.set(item.id, item);
    state.alerts = [...byId.values()].slice(0, 300);
    state.problem = null;
  } catch (err) {
    state.problem = `No se pudo leer el historial: ${formatError(err)}`;
  }
  updateCounts();
  scheduleRender('all');
}

// ── render ────────────────────────────────────────────────────────────────────

const view = document.getElementById('view');

function render() {
  const scroll = view.scrollTop;
  const search = document.activeElement?.id === 'track-search' ? document.activeElement : null;
  view.replaceChildren(...viewFor(state.tab));
  view.scrollTop = scroll;
  if (search) {
    const next = document.getElementById('track-search');
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  }
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('is-on', tab.dataset.tab === state.tab));
  updateCounts();

  // El detalle de un token vive por encima de la vista (modal), así que se re-monta acá.
  document.getElementById('detail-root')?.remove();
  const detail = renderDetail();
  if (detail) {
    detail.id = 'detail-root';
    document.body.append(detail);
  }
}

function updateCounts() {
  document.getElementById('count-alerts').textContent = String(state.alerts.length);
  // El badge del Track cuenta los ACTIVOS (lo que el ojo sigue), no los 500 cortados:
  // el toolbar igual muestra "activos/total".
  const tracked = state.track?.tokens ?? [];
  const active = tracked.filter((token) => token.status === 'active').length;
  const trackBadge = document.getElementById('count-track');
  trackBadge.textContent = String(active);
  trackBadge.title = `${active} activos de ${tracked.length} trackeados`;
  const dot = document.getElementById('conn-dot');
  const feeds = state.feeds.connected;
  const alerts = state.alertsConnected;
  dot.className = `dot ${feeds && alerts ? 'on' : feeds || alerts ? 'warn' : 'off'}`;
  document.getElementById('conn-text').textContent = `${hostOf(state.serverBase)} · track ${feeds ? '✓' : '✗'} · alertas ${alerts ? '✓' : '✗'}`;
  const last = state.alerts[0]?.notified_at;
  document.getElementById('alert-status').textContent = last ? `últ. ${clockOf(last)}` : state.notificationsOn ? 'sin alertas' : 'avisos off';
}

function hostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

function viewFor(tab) {
  if (tab === 'track') return [renderTrack()];
  if (tab === 'config') return [renderConfig()];
  return [renderAlerts()];
}

// ── Alertas ───────────────────────────────────────────────────────────────────

function renderAlerts() {
  const nodes = [];
  if (state.problem) nodes.push(el('div', { class: 'banner err', text: state.problem }));

  const filterRow = el('div', { class: 'toolbar' }, [
    el('span', { class: 'muted', text: 'Filtrar' }),
    ...['all', 'feeds', 'track'].map((key) =>
      el('button', {
        class: `ghost tiny${state.alertFilter === key ? ' primary' : ''}`,
        text: key === 'all' ? 'Todas' : key === 'feeds' ? 'Feeds' : 'Track',
        onclick: () => {
          state.alertFilter = key;
          render();
        },
      }),
    ),
    el('span', { style: 'flex:1' }),
    el('button', {
      class: 'ghost tiny',
      text: 'Probar',
      title: 'El server manda una alerta de prueba a este dispositivo',
      onclick: () => void testAlert(),
    }),
  ]);
  nodes.push(filterRow);

  const items = state.alerts.filter((a) => state.alertFilter === 'all' || categoryGroup(a.category) === state.alertFilter);
  if (!items.length) {
    nodes.push(
      el('div', { class: 'empty' }, [
        el('div', { text: 'Todavía no hay alertas para este dispositivo.' }),
        el('div', {
          text:
            'Encendé categorías en Ajustes (y usá "Probar" para ver el camino completo). Las alertas se avisan con una ' +
            'notificación de Chrome y quedan listadas acá.',
        }),
      ]),
    );
    return el('div', {}, nodes);
  }

  nodes.push(
    el(
      'div',
      { class: 'rows' },
      items.map((alert) =>
        tokenRow({
          symbol: alert.symbol || alert.name || alert.address.slice(0, 6),
          sub: `${clockOf(alert.notified_at)} · ${categoryGroup(alert.category) === 'track' ? 'Track' : 'Feed'}`,
          chips: [
            chip(CATEGORY_LABELS[alert.category] ?? alert.category, categoryGroup(alert.category) === 'track' ? 'violet' : null),
            alert.mcap ? chip(`MC $${compactUsd(alert.mcap)}`) : null,
            alert.vol24h ? chip(`VOL $${compactUsd(alert.vol24h)}`) : null,
            alert.holders ? chip(`${alert.holders} holders`) : null,
          ],
          side: [el('span', { class: 'muted', text: timeAgo(alert.notified_at) }), el('span', { class: 'muted', text: '↗' })],
          title: CATEGORY_HINTS[alert.category] ?? '',
          // CAL100+ manda el detalle armado (wallet, montos, PnL) en `body`; el resto
          // de las categorías no lo trae y la fila queda como estaba.
          note: alert.body ?? '',
          onClick: () => openOnGmgn(alert.address),
        }),
      ),
    ),
  );
  return el('div', {}, nodes);
}

async function testAlert() {
  const result = await sw('test-alert');
  state.notice = result?.ok
    ? 'Alerta de prueba enviada — debería aparecer la notificación y la fila acá.'
    : `No se pudo probar: ${result?.error ?? 'sin respuesta del service worker'}`;
  scheduleRender('all');
}

// ── Track ─────────────────────────────────────────────────────────────────────

function renderTrack() {
  const nodes = [];
  const tokens = state.track?.tokens ?? [];
  const active = tokens.filter((t) => t.status === 'active').length;
  const stale = state.trackAt ? timeAgo(new Date(state.trackAt).toISOString()) : null;

  nodes.push(
    el('div', { class: 'toolbar' }, [
      el('input', {
        id: 'track-search',
        type: 'search',
        placeholder: 'Buscar símbolo o address…',
        value: state.query,
        oninput: (event) => {
          state.query = event.target.value;
          render();
        },
      }),
      el('button', {
        class: `ghost tiny${state.onlyActive ? ' primary' : ''}`,
        text: 'Activos',
        title: 'Solo los tracks abiertos (< 50 snapshots)',
        onclick: () => {
          state.onlyActive = !state.onlyActive;
          render();
        },
      }),
      el('span', { class: 'muted', text: `${active}/${tokens.length}${stale ? ` · ${stale}` : ''}` }),
    ]),
  );

  if (!tokens.length) {
    nodes.push(el('div', { class: 'empty', text: state.feeds.connected ? 'El tracker todavía no capturó tokens (revisá su proxy y filtros en la app → Track).' : 'Conectando al server…' }));
    return el('div', {}, nodes);
  }

  const query = state.query.trim().toLowerCase();
  const filtered = tokens
    .filter((t) => (state.onlyActive ? t.status === 'active' : true))
    .filter((t) => (query ? `${t.symbol ?? ''} ${t.name ?? ''} ${t.address}`.toLowerCase().includes(query) : true));

  if (!filtered.length) nodes.push(el('div', { class: 'empty', text: 'Nada que coincida con el filtro.' }));

  nodes.push(
    el(
      'div',
      { class: 'rows' },
      filtered.map((token) => trackRow(token)),
    ),
  );
  return el('div', {}, nodes);
}

function trackRow(token) {
  const gain = token.gainPct;
  const chips = [
    token.health ? chip(`● ${token.health}`, toneOfHealth(token.health)) : null,
    chipNum('SMART', token.smartTraderPct != null ? `${Number(token.smartTraderPct).toFixed(1)}%` : null),
    token.creatorMints != null ? chip(`DEV ${token.creatorMints}/${token.creatorGraduated ?? 0}`) : null,
    chipNum('TESIS', token.thesesCount, 'violet'),
    chipNum('CHAT', token.chatWallets),
    token.callout100to500 ? chip(`CAL100 ${token.callout100to500}`, 'amber') : null,
    token.callout500 ? chip(`CAL500 ${token.callout500}`, 'amber') : null,
    token.topDaily ? chip(`TOP·D ${token.topDaily}`, 'green') : null,
    token.topWeekly ? chip(`W ${token.topWeekly}`) : null,
    token.topMonthly ? chip(`M ${token.topMonthly}`) : null,
    token.holdersDeltaPct != null ? chip(`H ${signedPct(token.holdersDeltaPct)}`, token.holdersDeltaPct >= 0 ? 'green' : 'red') : null,
    token.turnover != null ? chip(`T ${Number(token.turnover).toFixed(1)}x`, token.turnover >= 10 ? 'red' : null) : null,
  ];
  return tokenRow({
    symbol: token.symbol || token.name || token.address.slice(0, 6),
    sub: `${token.status === 'active' ? 'activo' : 'cortado'} · ${token.snapshotCount} snaps · ${timeAgo(token.firstSeenAt)} de vida`,
    chips,
    side: [
      el('span', { class: 'mcap', text: `$${compactUsd(token.mcap)}` }),
      gain == null ? null : el('span', { class: gain > 0 ? 'green' : gain < 0 ? 'red' : 'muted', text: signedPct(gain) }),
    ],
    onClick: () => void openTrackDetail(token.address, token.symbol),
  });
}

async function openTrackDetail(address, symbol) {
  if (!address) return;
  state.tab = 'track';
  state.detail = { loading: true, address, symbol, token: null, error: null };
  render();
  try {
    const token = await apiCall(state.serverBase, `/api/track/${encodeURIComponent(address)}`);
    state.detail = { loading: false, address, symbol: token?.symbol ?? symbol, token, error: null };
  } catch (err) {
    state.detail = { loading: false, address, symbol, token: null, error: formatError(err) };
  }
  render();
}

/**
 * PnL de una ventana (1d / 1w) de una entrada CAL100. Sólo se pinta lo positivo:
 *   positivo → verde con el %;
 *   en rojo o en cero → celda vacía;
 *   '—' → no se pudo leer (2 intentos y nada) o la wallet NO operó en la ventana
 *         (tokenCount 0: inactiva no es lo mismo que en pérdida).
 */
function cal100Cell(usd, pct, tokens) {
  const noTrades = tokens === 0 && usd === 0;
  if (usd == null || noTrades) return { text: '—', cls: 'muted' };
  if (!(usd > 0)) return { text: '', cls: '' };
  const money = `+$${compactUsd(usd)}`;
  return { text: pct > 0 ? `${money} (${signedPct(pct, 1)})` : money, cls: 'green' };
}

/**
 * ENTRADAS CAL100 del token: una fila por wallet con callout ≥$100 que APARECIÓ
 * en el track (la hora en que se sumó) con el PnL de su portfolio leído en ese
 * momento. Se listan sólo las que están en ganancia en alguna ventana (las
 * pérdidas no se pintan). Es el PnL de toda su cartera en la ventana, no el de su
 * posición acá. Sin PnL positivo en ninguna ventana, no hay bloque.
 */
function cal100Block(token) {
  const events = (token?.call100Events ?? []).filter((e) => (e.pnl1dUsd ?? 0) > 0 || (e.pnl1wUsd ?? 0) > 0);
  if (!events.length) return null;
  const table = el('table', { class: 'snaps cal' });
  table.append(el('thead', {}, [el('tr', {}, ['Hora', 'Wallet', 'Metió', '1D', '1W'].map((c) => el('th', { text: c })))]));
  table.append(
    el(
      'tbody',
      {},
      [...events].reverse().map((e) => {
        const day = cal100Cell(e.pnl1dUsd, e.pnl1dPct, e.tokens1d);
        const week = cal100Cell(e.pnl1wUsd, e.pnl1wPct, e.tokens1w);
        return el('tr', {}, [
          // La hora (como la tabla de snapshots); el minuto del track, al pasar el mouse.
          el('td', { text: clockOf(e.at), title: `min ${e.minute} · ${e.at}` }),
          el('td', { text: shortAddr(e.address), title: e.address }),
          el('td', { text: e.usd == null ? '—' : `$${compactUsd(e.usd)}` }),
          el('td', { text: day.text, class: day.cls }),
          el('td', { text: week.text, class: week.cls }),
        ]);
      }),
    ),
  );
  return el('div', {}, [
    el('p', { class: 'cal-title', text: `Entradas CAL100 · ${events.length} — PnL del portfolio de la wallet al entrar` }),
    table,
  ]);
}

function renderDetail() {
  const detail = state.detail;
  if (!detail) return null;
  const close = () => {
    state.detail = null;
    render();
  };
  const token = detail.token;
  const rows = token?.snapshots ?? [];
  const snaps = [...rows.entries()].slice(Math.max(0, rows.length - SNAPSHOT_ROWS));

  const head = el('div', { class: 'modal-head' }, [
    el('div', { class: 'row-top' }, [
      el('span', { class: 'sym', text: token?.symbol || detail.symbol || detail.address.slice(0, 6) }),
      token ? chip(`$${compactUsd(token.mcap)}`, 'violet') : null,
      token?.gainPct != null ? chip(signedPct(token.gainPct), token.gainPct > 0 ? 'green' : 'red') : null,
      token ? chip(`${token.snapshotCount} snaps`) : null,
      token ? chip(token.status === 'active' ? 'activo' : 'cortado') : null,
    ]),
    el('div', { class: 'chips' }, [
      el('button', { class: 'ghost tiny', text: 'GMGN ↗', onclick: () => openOnGmgn(detail.address) }),
      el('button', { class: 'ghost tiny', text: 'Cerrar', onclick: close }),
    ]),
  ]);

  const body = el('div', { class: 'modal-body' });
  const cal100 = cal100Block(token);
  if (detail.loading) body.append(el('div', { class: 'empty', text: 'Cargando snapshots…' }));
  else if (detail.error) body.append(el('div', { class: 'banner err', text: detail.error }));
  else if (!snaps.length) {
    if (cal100) body.append(cal100);
    else body.append(el('div', { class: 'empty', text: 'Sin snapshots guardados.' }));
  } else {
    if (cal100) body.append(cal100);
    const columns = ['#', 'MCap', 'Vol', 'Holders', 'TP', 'Bundle%', 'Top%', 'Chat', 'Tesis', 'TOP·D', 'CAL 1-5', 'CAL 5+', 'Salud', 'Señal'];
    const table = el('table', { class: 'snaps' });
    table.append(el('thead', {}, [el('tr', {}, columns.map((c) => el('th', { text: c })))]));
    table.append(
      el(
        'tbody',
        {},
        [...snaps].reverse().map(([index, snap]) =>
          el('tr', {}, [
            el('td', { text: clockOf(snap.at) === '—' ? String(index) : clockOf(snap.at), title: snap.at }),
            el('td', { text: snap.mcap == null ? '—' : `$${compactUsd(snap.mcap)}` }),
            el('td', { text: snap.volume == null ? '—' : `$${compactUsd(snap.volume)}` }),
            el('td', { text: snap.holders ?? '—' }),
            el('td', { text: snap.tpHolders ?? '—' }),
            el('td', { text: snap.bundlePct == null ? '—' : `${snap.bundlePct}%` }),
            el('td', { text: snap.topHoldersPct == null ? '—' : `${snap.topHoldersPct}%` }),
            el('td', { text: snap.chatWallets ?? '—' }),
            el('td', { text: snap.thesesCount ?? '—' }),
            el('td', { text: snap.topDaily ?? '—' }),
            el('td', { text: snap.callout100to500 ?? '—' }),
            el('td', { text: snap.callout500 ?? '—' }),
            el('td', { text: snap.health ?? '—', class: toneOfHealth(snap.health) ?? '' }),
            el('td', { text: snap.buySignal ?? '—', class: snap.buySignal === 'buy' ? 'green' : snap.buySignal === 'avoid' ? 'red' : '' }),
          ]),
        ),
      ),
    );
    body.append(table);
    body.append(el('p', { class: 'note', text: `Últimos ${snaps.length} snapshots de ${rows.length} (uno por minuto, el # es el minuto desde la entrada).` }));
  }

  return el('div', { class: 'modal', onclick: (event) => { if (event.target === event.currentTarget) close(); } }, [el('div', { class: 'modal-card' }, [head, body])]);
}

// ── Ajustes ───────────────────────────────────────────────────────────────────

function renderConfig() {
  const nodes = [];
  if (state.notice) nodes.push(el('div', { class: 'banner ok', text: state.notice }));
  if (state.problem) nodes.push(el('div', { class: 'banner err', text: state.problem }));
  if (state.syncError) {
    nodes.push(
      el('div', {
        class: 'banner err',
        text: `El server no aceptó el registro del dispositivo (${state.syncError}): así no llega ninguna alerta. Revisá la URL y los permisos.`,
      }),
    );
  }

  const serverInput = el('input', { type: 'text', value: state.serverBase, spellcheck: 'false' });
  nodes.push(
    el('div', { class: 'card' }, [
      el('h3', { text: 'Server' }),
      el('div', { class: 'field' }, [el('label', { text: 'URL' }), serverInput]),
      el('div', { class: 'chips' }, [
        el('button', {
          class: 'ghost primary',
          text: 'Guardar y reconectar',
          onclick: () => void saveConfig({ serverBase: serverInput.value.trim() }),
        }),
        el('button', {
          class: 'ghost',
          text: 'Permitir acceso',
          title: 'Chrome exige permiso por origen para que la extensión lea ese server',
          onclick: () => void requestOrigin(serverInput.value.trim()),
        }),
      ]),
      el('p', { class: 'note', text: 'Es el mismo server de la app (Railway). Si lo cambiás, dale "Permitir acceso" para que Chrome deje leer ese origen.' }),
    ]),
  );

  nodes.push(
    el('div', { class: 'card' }, [
      el('h3', { text: 'Avisos' }),
      el('label', { class: 'toggle' }, [
        el('input', {
          type: 'checkbox',
          checked: state.notificationsOn,
          onchange: (event) => void saveConfig({ notificationsOn: event.target.checked }),
        }),
        el('span', { class: 'tx' }, [el('b', { text: 'Notificación de Chrome' }), el('small', { text: 'Si lo apagás, las alertas solo se listan acá.' })]),
      ]),
      el('p', { class: 'note', text: `Dispositivo: ${state.deviceId || '—'} · alertas ${state.alertsConnected ? 'conectadas' : 'desconectadas'}.` }),
    ]),
  );

  const group = (title, ids) =>
    el('div', { class: 'card' }, [
      el('h3', { text: title }),
      ...ids.map((id) =>
        el('label', { class: 'toggle' }, [
          el('input', {
            type: 'checkbox',
            checked: Boolean(state.categories[id]),
            onchange: (event) => void saveConfig({ categories: { ...state.categories, [id]: event.target.checked } }),
          }),
          el('span', { class: 'tx' }, [
            el('b', { text: CATEGORY_LABELS[id] ?? id }),
            el('small', { text: CATEGORY_HINTS[id] ?? '' }),
          ]),
        ]),
      ),
    ]);

  nodes.push(group('Feeds (alerta, sin tablero acá)', ALERT_CATEGORIES.filter((id) => categoryGroup(id) === 'feeds')));
  nodes.push(
    group(
      'Track (entrada del token)',
      ALERT_CATEGORIES.filter((id) => categoryGroup(id) === 'track'),
    ),
  );

  const paramRow = (key, label, min, max) =>
    el('div', { class: 'field' }, [
      el('label', { text: label }),
      el('input', {
        class: 'narrow',
        type: 'text',
        inputmode: 'numeric',
        value: String(state.params[key]),
        onchange: (event) => void saveConfig({ params: { ...state.params, [key]: event.target.value } }),
      }),
      el('span', { class: 'muted', text: `${min}-${max}` }),
    ]);

  nodes.push(
    el('div', { class: 'card' }, [
      el('h3', { text: 'Umbrales del Track' }),
      paramRow('chatWalletsMin', 'Chat ≥ wallets', 1, 50),
      paramRow('tesisMin', 'Tesis ≥', 1, 20),
      paramRow('topMin', 'TOP·D ≥', 1, 10),
      el('p', {
        class: 'note',
        text:
          'Mismos umbrales que la app y por dispositivo (el server guarda los de este navegador aparte). Las 5 reglas del Track se ' +
          'evalúan en el snapshot de ENTRADA del token, una vez por token.',
      }),
      el('div', { class: 'chips' }, [
        el('button', { class: 'ghost', text: 'Probar alerta', onclick: () => void testAlert() }),
        el('button', { class: 'ghost', text: 'Reconectar', onclick: () => void reconnect() }),
      ]),
    ]),
  );

  nodes.push(
    el('div', { class: 'card' }, [
      el('h3', { text: 'Cómo funciona' }),
      el('p', {
        class: 'note',
        text:
          'Este panel hace dos cosas: las alertas de este dispositivo (con sus categorías y sus umbrales) y el tracker. No hay ' +
          'cuenta ni cartera acá — el trading sigue en la app, y los tableros de FOMO/Photon/Pump tampoco están: sus filtros se ' +
          'aplican en el teléfono, así que un espejo mostraría otra cosa. Las alertas se avisan con una notificación de Chrome; ' +
          'hacer click abre este panel en el token (o GMGN si Chrome no lo permite).',
      }),
    ]),
  );

  return el('div', {}, nodes);
}

async function saveConfig(patch) {
  state.notice = null;
  state.problem = null;
  if (patch.serverBase != null) state.serverBase = patch.serverBase || DEFAULT_SERVER;
  if (patch.categories) state.categories = { ...state.categories, ...patch.categories };
  if (patch.params) state.params = { ...state.params, ...patch.params };
  if (patch.notificationsOn != null) state.notificationsOn = patch.notificationsOn;

  const result = await sw('save-config', {
    serverBase: state.serverBase,
    categories: state.categories,
    params: state.params,
  });
  if (result?.ok) {
    state.notice = patch.notificationsOn != null ? 'Guardado.' : 'Configuración guardada y sincronizada con el server.';
    state.syncError = null;
    // La respuesta del server es la fuente de verdad de los umbrales saneados.
    const stored = await getSettings();
    state.categories = stored.categories;
    state.params = stored.params;
    if (patch.serverBase != null) {
      connectFeeds();
      void refreshHistory();
    }
  } else {
    state.syncError = result?.error ?? null;
    state.problem = `No se pudo sincronizar: ${result?.error ?? 'el service worker no respondió'}`;
  }
  scheduleRender('all');
}

async function requestOrigin(base) {
  const origin = originOf(base);
  if (!origin) {
    state.problem = 'Esa URL no es válida.';
    scheduleRender('all');
    return;
  }
  try {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    state.notice = granted ? `Permiso concedido para ${origin}. Ya podés guardar y reconectar.` : `Permiso rechazado para ${origin}.`;
  } catch (err) {
    state.problem = formatError(err);
  }
  scheduleRender('all');
}

async function reconnect() {
  const result = await sw('reconnect');
  state.notice = result?.connected ? 'Alertas reconectadas.' : 'No se pudo reconectar con el server.';
  connectFeeds();
  scheduleRender('all');
}

// ── acciones ──────────────────────────────────────────────────────────────────

function openOnGmgn(address) {
  if (!address) return;
  chrome.tabs.create({ url: `https://gmgn.ai/sol/token/${address}` });
}

// ── arranque ──────────────────────────────────────────────────────────────────

document.getElementById('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab')?.dataset.tab;
  if (!tab) return;
  state.tab = tab;
  render();
});

document.getElementById('btn-reload').addEventListener('click', () => {
  void reconnect();
  void refreshHistory();
});

async function init() {
  const stored = await getSettings();
  state.serverBase = stored.serverBase;
  state.categories = stored.categories;
  state.params = stored.params;
  state.notificationsOn = stored.notificationsOn;

  const device = await sw('get-state');
  state.deviceId = device?.deviceId ?? '';
  state.alertsConnected = Boolean(device?.connected);
  state.syncError = device?.syncError ?? null;

  connectFeeds();
  render();
  await refreshHistory();
}

void init();
