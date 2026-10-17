import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Image as ExpoImage, type ImageSource } from 'expo-image';

import { Icon, type IconName } from '@/components/icons';
import { TokenAvatar } from '@/components/token-avatar';
import { Banner, Btn, Card, DetailRow, Empty, Input, SegTabs, Skeleton } from '@/components/ui';
import { Palette, Radius, toneTint } from '@/constants/paper';
import {
  dayLabel,
  formatCompactQty,
  formatCompactUsd,
  formatDateTime,
  formatPrice,
  formatPct,
  formatUsd,
  pnlClass,
  timeOf,
  tone,
} from '@/lib/format';
import { api } from '@/lib/api';
import { serverFeed, ServerFeed, TOPICS } from '@/lib/market/server-feed';
import { alertDeepLink, fetchHistory, type AlertHistoryEntry } from '@/lib/notifications';
import { TRACK_FILTER_FIELDS, clearTrackTokens, fetchTrack, fetchTrackToken, saveTrackConfig, testTrackProxy, type ProxyTestResult, type TrackConfig, type TrackState, type TrackTokenDetail, type TrackTokenSummary } from '@/lib/track';
import type { Trade } from '@/lib/types';
import { useApp } from '@/state/app';

type SideFilter = '' | 'BUY' | 'SELL';
/** Trade fills, the alert feed (FOMO/Photon) and the token tracker share one History page. */
type HistoryMode = 'trades' | 'alerts' | 'track';

/** Server alert categories → labels, same taxonomy as the floating panel. */
const ALERT_LABELS: Record<string, string> = {
  fomo_graduated: 'FOMO Grad.',
  fomo_trending: 'FOMO Trend.',
  photon_new: 'Photon New',
  photon_graduated: 'Photon Grad.',
  track_buy: 'Track COMPRAR',
  track_top_tesis: 'Track TOP+TES',
  track_atencion_m1: 'Track ATENCIÓN',
};

const toneColor = (v: number | null | undefined) =>
  pnlClass(v) === 'up' ? Palette.green : pnlClass(v) === 'down' ? Palette.red : Palette.textPrimary;

/** Las horas de los snapshots en formato militar (24h, sin AM/PM): "14:50". */
const time24 = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

// The health chip (server-computed from the snapshot series) — shared with the
// Trade/FOMO/Photon chips via `@/components/track-health-chip` (same labels).

// How often the Track tab re-polls the server while visible. Snapshots land every
// 60s, so 15s keeps the list honest (status flips, new tokens, snapshot counts)
// without chatty requests.
const TRACK_REFRESH_MS = 15_000;
// The server PUSHES the track state (throttled on its side); the HTTP poll below
// is only the safety net, so it skips while pushes are arriving.
const TRACK_PUSH_FRESH_MS = 60_000;

/**
 * The tracked list is virtualized and every row is memoized, so a poll must NOT
 * hand React fresh objects for rows whose data didn't change — with hundreds of
 * tracked tokens, re-rendering them all every 15s is exactly what made the tab
 * crawl. Every summary field is a primitive, so identity is the comparison.
 */
const sameSummary = (a: TrackTokenSummary, b: TrackTokenSummary): boolean => {
  for (const key of Object.keys(a) as (keyof TrackTokenSummary)[]) if (a[key] !== b[key]) return false;
  return true;
};

/** Group headers + rows, in render order — built once per (tokens, sort) change. */
type TrackRowItem =
  | { kind: 'header'; group: 'active' | 'done'; count: number }
  | { kind: 'token'; t: TrackTokenSummary };

export default function HistoryScreen() {
  const { ready, user, banner, settings, updateSettings, flash } = useApp();
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [side, setSide] = useState<SideFilter>('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  // Alerts are keyed by device (X-Device-Id), so they load with or without an account.
  const [mode, setMode] = useState<HistoryMode>('trades');
  const [alerts, setAlerts] = useState<AlertHistoryEntry[] | null>(null);
  const [alertQuery, setAlertQuery] = useState('');
  // The token tracker is global server data: config, health and the tracked list,
  // then one snapshot series per row on demand.
  const [track, setTrack] = useState<TrackState | null>(null);
  const [trackConfigOpen, setTrackConfigOpen] = useState(false);
  const [trackDraft, setTrackDraft] = useState<TrackConfig | null>(null);
  const [proxyTest, setProxyTest] = useState<{ busy: boolean; result: ProxyTestResult | null }>({ busy: false, result: null });
  const [trackDetail, setTrackDetail] = useState<Record<string, TrackTokenDetail>>({});
  const [expandedTrack, setExpandedTrack] = useState<string | null>(null);
  // The refresh closure must see the CURRENT open row, not the one that existed
  // when the interval was created — a ref keeps it honest without re-subscribing.
  const expandedTrackRef = useRef<string | null>(null);
  useEffect(() => {
    expandedTrackRef.current = expandedTrack;
  }, [expandedTrack]);
  // The row press handler stays STABLE (no dep churn): with memoized rows, a
  // callback identity change would re-render the whole list for nothing.
  const trackDetailRef = useRef(trackDetail);
  const flashRef = useRef(flash);
  const serverBaseRef = useRef(settings.serverBase);
  useEffect(() => {
    trackDetailRef.current = trackDetail;
    flashRef.current = flash;
    serverBaseRef.current = settings.serverBase;
  }, [trackDetail, flash, settings.serverBase]);
  const [clearArmed, setClearArmed] = useState(false);
  const [trackSort, setTrackSort] = useState<'recent' | 'gain'>('recent');
  const [trackQuery, setTrackQuery] = useState('');

  // ONE merge path, shared by the WS push and the HTTP fallback: rows whose data
  // didn't change keep their object identity (the memoized rows skip the
  // re-render), and when nothing at all changed the SAME state object goes back
  // so React bails out of the render entirely.
  const applyTrackState = useCallback((next: TrackState) => {
    setTrack((prev) => {
      // Never blank out a config we already hold if a restart wiped the server
      // mid-session (the mirror heals it on the next full load).
      const serverEmpty = !next.config.proxy && !Object.keys(next.config.filters).length;
      const keep = prev?.config;
      const config = serverEmpty && keep && (keep.proxy || Object.keys(keep.filters ?? {}).length) ? keep : next.config;
      if (!prev) return { ...next, config };
      const prevByAddress = new Map(prev.tokens.map((t) => [t.address, t]));
      const tokens = next.tokens.map((t) => {
        const old = prevByAddress.get(t.address);
        return old && sameSummary(old, t) ? old : t;
      });
      const statusSame = JSON.stringify(prev.status) === JSON.stringify(next.status);
      const configSame = JSON.stringify(prev.config) === JSON.stringify(config);
      if (configSame && statusSame && prev.tokens.length === tokens.length && tokens.every((t, i) => t === prev.tokens[i])) {
        return prev;
      }
      return { ...next, config: configSame ? prev.config : config, status: statusSame ? prev.status : next.status };
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (mode !== 'trades' || !user) return;
      void api
        .trades()
        .then((r) => setTrades(r.trades))
        .catch(() => setTrades((t) => t ?? []));
    }, [user, mode]),
  );

  useFocusEffect(
    useCallback(() => {
      if (mode !== 'alerts') return;
      void fetchHistory(settings.serverBase, 100)
        .then(setAlerts)
        .catch(() => setAlerts((a) => a ?? []));
    }, [mode, settings.serverBase]),
  );

  // The tracker keeps working server-side every 1.3s — the tab follows it without
  // making the user leave and come back. Load once on focus (with the mirror
  // self-heal), then LIVE: the server pushes the state on the `track` topic
  // (throttled there) while the tab is subscribed; the 15s HTTP poll only runs
  // as the safety net when the socket is silent.
  useFocusEffect(
    useCallback(() => {
      if (mode !== 'track') return;

      const load = () => {
        void fetchTrack(settings.serverBase)
          .then((state) => {
            // A restarted server comes back with an empty config store — restore the
            // app's mirror (saved on every "Guardar") so proxy + filters survive.
            const mirror = settings.trackConfig;
            const serverEmpty = !state.config.proxy && !Object.keys(state.config.filters).length;
            const adopt = (config: TrackState['config']) => {
              applyTrackState({ ...state, config });
              setTrackDraft((d) => d ?? config);
            };
            if (serverEmpty && mirror && (mirror.proxy || Object.keys(mirror.filters ?? {}).length)) {
              return saveTrackConfig(settings.serverBase, mirror)
                .then((saved) => adopt(saved))
                .catch(() => adopt(state.config));
            }
            adopt(state.config);
          })
          .catch(() => setTrack((t) => t ?? { config: { enabled: false, proxy: '', filters: {} }, status: null, tokens: [] }));
      };

      const refresh = () => {
        void fetchTrack(settings.serverBase)
          .then(applyTrackState)
          .catch(() => {});
        const open = expandedTrackRef.current;
        if (open) {
          void fetchTrackToken(settings.serverBase, open)
            .then((d) => setTrackDetail((all) => ({ ...all, [open]: d })))
            .catch(() => {});
        }
      };

      // Live: the server PUSHES the whole track state on this topic (throttled
      // on ITS side, and only while someone is subscribed). The HTTP poll stays
      // wired as the safety net for a dead socket or a server without the topic.
      let lastPushAt = 0;
      let lastDetailAt = 0;
      const offTopic = serverFeed.onTopic(TOPICS.track, (data) => {
        const next = data as TrackState | null;
        if (!next?.tokens || !next.status) return;
        lastPushAt = Date.now();
        applyTrackState(next);
        // The open row's snapshot series is NOT part of the list payload — top
        // it up, but at the poll's rhythm, not at the push's (pushes run hot).
        const open = expandedTrackRef.current;
        if (open && Date.now() - lastDetailAt >= TRACK_REFRESH_MS) {
          lastDetailAt = Date.now();
          void fetchTrackToken(settings.serverBase, open)
            .then((d) => setTrackDetail((all) => ({ ...all, [open]: d })))
            .catch(() => {});
        }
      });
      serverFeed.subscribeTopic(TOPICS.track);
      // The socket is shared (alerts/Photon/FOMO keep it up) — make sure it is
      // there even for a phone that only ever opens Track. subscribeTopic is
      // sticky, so the subscription rides along whenever the socket comes up.
      void ServerFeed.ensureConnected(settings.serverBase);

      load();
      const poll = setInterval(() => {
        // Pushes arriving = the socket IS the refresh; only poll when silent.
        if (serverFeed.status().connected && Date.now() - lastPushAt < TRACK_PUSH_FRESH_MS) return;
        refresh();
      }, TRACK_REFRESH_MS);
      const sub = AppState.addEventListener('change', (s) => {
        if (s === 'active') refresh();
      });
      return () => {
        clearInterval(poll);
        sub.remove();
        offTopic();
        serverFeed.unsubscribeTopic(TOPICS.track);
      };
    }, [mode, settings.serverBase, settings.trackConfig, applyTrackState]),
  );

  const visible = useMemo(() => {
    if (!trades) return null;
    const q = query.trim().toUpperCase();
    return trades.filter((t) => (side ? t.side === side : true) && (q ? (t.symbol ?? '').toUpperCase().includes(q) : true));
  }, [trades, side, query]);

  const visibleAlerts = useMemo(() => {
    if (!alerts) return null;
    const q = alertQuery.trim().toUpperCase();
    if (!q) return alerts;
    return alerts.filter(
      (e) => (e.symbol ?? '').toUpperCase().includes(q) || (e.name ?? '').toUpperCase().includes(q),
    );
  }, [alerts, alertQuery]);

  const trackFilterCount = Object.keys(trackDraft?.filters ?? track?.config.filters ?? {}).length;

  // Grouping + sorting in one memo: the render pass just walks the array, and
  // the FlatList gets stable `data` references (a fresh array every render would
  // defeat its own virtualization).
  const trackTokens = track?.tokens;
  const trackRows = useMemo<TrackRowItem[]>(() => {
    if (!trackTokens) return [];
    // Search by symbol or name: when a query is active the group headers are
    // dropped (a 2-row result under "Terminados · 143" reads as an error).
    const q = trackQuery.trim().toUpperCase();
    const rows: TrackRowItem[] = [];
    for (const group of ['active', 'done'] as const) {
      const entries = trackTokens
        .filter((t) => t.status === group)
        .filter(
          (t) =>
            !q ||
            (t.symbol ?? '').toUpperCase().includes(q) ||
            (t.name ?? '').toUpperCase().includes(q),
        )
        // server order is newest activity; "Ganancia" ranks by first→max MC
        .sort((a, b) => (trackSort === 'gain' ? (b.gainPct ?? -Infinity) - (a.gainPct ?? -Infinity) : 0));
      if (!entries.length) continue;
      if (!q) rows.push({ kind: 'header', group, count: entries.length });
      for (const t of entries) rows.push({ kind: 'token', t });
    }
    return rows;
  }, [trackTokens, trackSort, trackQuery]);

  const saveTrack = (next: TrackConfig) => {
    void saveTrackConfig(settings.serverBase, next)
      .then((saved) => {
        setTrackDraft(saved);
        setTrack((t) => (t ? { ...t, config: saved } : t));
        // Mirror into settings: a server restart can't lose what was configured here.
        void updateSettings({ trackConfig: saved });
        flash('ok', 'Filtros de Track guardados');
      })
      .catch((err) => flash('err', `No se guardaron: ${err instanceof Error ? err.message : String(err)}`));
  };

  // "Probar": one real fetch through the DRAFT proxy (test before saving).
  const runProxyTest = () => {
    setProxyTest({ busy: true, result: null });
    void testTrackProxy(settings.serverBase, trackDraft?.proxy || undefined)
      .then((result) => setProxyTest({ busy: false, result }))
      .catch((err) => setProxyTest({ busy: false, result: { ok: false, ms: 0, error: err instanceof Error ? err.message : String(err) } }));
  };

  // Two taps within 3s to wipe — one accidental tap shouldn't destroy the set.
  const clearAllTrack = () => {
    if (!clearArmed) {
      setClearArmed(true);
      setTimeout(() => setClearArmed(false), 3000);
      return;
    }
    setClearArmed(false);
    void clearTrackTokens(settings.serverBase)
      .then(() => {
        flash('ok', 'Trackeos borrados');
        setTrack((t) => (t ? { ...t, tokens: [] } : t));
        setTrackDetail({});
        setExpandedTrack(null);
      })
      .catch((err) => flash('err', `No se borró: ${err instanceof Error ? err.message : String(err)}`));
  };

  const toggleTrackRow = useCallback((address: string) => {
    const willOpen = expandedTrackRef.current !== address;
    setExpandedTrack(willOpen ? address : null);
    if (willOpen && !trackDetailRef.current[address]) {
      void fetchTrackToken(serverBaseRef.current, address)
        .then((d) => setTrackDetail((all) => ({ ...all, [address]: d })))
        .catch(() => flashRef.current('err', 'No se pudieron cargar los snapshots'));
    }
  }, []);

  if (!ready) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <View style={styles.body}>
          <Skeleton height={90} />
          <Skeleton height={240} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>History</Text>
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push('/settings')} hitSlop={10} style={styles.gear}>
          <Icon name="gear" size={18} color={Palette.textSecondary} />
        </Pressable>
      </View>

      {mode === 'track' ? (
        // Virtualized list: with hundreds of tracked tokens, a ScrollView mounts
        // every row at once (thousands of native views) and every 15s poll
        // re-rendered all of them. FlatList paints only what's on screen.
        <FlatList
          data={trackRows}
          keyExtractor={(item) => (item.kind === 'header' ? `hdr-${item.group}` : item.t.address)}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={9}
          removeClippedSubviews
          ListHeaderComponent={
            <View style={{ gap: 10 }}>
              {banner ? <Text style={styles.banner}>{banner.text}</Text> : null}

              <View style={styles.filters}>
                <SegTabs
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'trades' as HistoryMode, label: 'Trades' },
                    { value: 'alerts' as HistoryMode, label: 'Alertas' },
                    { value: 'track' as HistoryMode, label: 'Track' },
                  ]}
                />
              </View>

              <View style={styles.trackTop}>
                <Btn
                  label={trackConfigOpen ? 'Ocultar filtros' : `Filtros${trackFilterCount ? ` · ${trackFilterCount}` : ''}`}
                  variant="sm"
                  icon={trackConfigOpen ? 'check' : 'search'}
                  onPress={() => setTrackConfigOpen((v) => !v)}
                />
                <Btn label={clearArmed ? '¿Seguro?' : 'Borrar'} variant="danger" icon="trash" onPress={clearAllTrack} />
                <View style={{ flex: 1 }} />
                <Text style={styles.rowSub}>Trackeo</Text>
                <Switch
                  value={track?.config.enabled ?? false}
                  onValueChange={(v) => saveTrack({ ...(trackDraft ?? track?.config ?? { enabled: true, proxy: '', filters: {} }), enabled: v })}
                  trackColor={{ false: Palette.lineStrong, true: Palette.paperT }}
                  thumbColor={Palette.bgPrimary}
                />
              </View>

              {trackConfigOpen && trackDraft ? (
                <Card style={{ padding: 12, gap: 8 }}>
                  <View style={{ gap: 4 }}>
                    <Text style={styles.filterLabel}>Proxy propio del track</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Input
                        value={trackDraft.proxy}
                        onChangeText={(v) => setTrackDraft((d) => (d ? { ...d, proxy: v } : d))}
                        placeholder="http://user:pass@host:port"
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        style={{ flex: 1 }}
                      />
                      <Btn label="Probar" variant="sm" busy={proxyTest.busy} onPress={runProxyTest} />
                    </View>
                    <Text style={styles.detailHint}>
                      Distinto al de FOMO y Photon — el track solo sale por este. Formato: http://host:port o
                      socks5://host:port. Sin proxy, no arranca.
                    </Text>
                    {proxyTest.result ? (
                      <Text style={[styles.detailHint, { color: proxyTest.result.ok ? Palette.green : Palette.red }]}>
                        {proxyTest.result.ok
                          ? `✓ responde en ${proxyTest.result.ms} ms — vio ${proxyTest.result.tokens ?? 0} tokens de Graduated con tus filtros`
                          : `✗ ${proxyTest.result.error}`}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.filterGrid}>
                    {TRACK_FILTER_FIELDS.map((f) => (
                      <View key={f.key} style={styles.filterField}>
                        <Text style={styles.filterLabel}>{f.label}</Text>
                        <View style={styles.filterPair}>
                          <Input
                            value={trackDraft.filters[f.key]?.min ?? ''}
                            onChangeText={(v) =>
                              setTrackDraft((d) => (d ? { ...d, filters: { ...d.filters, [f.key]: { ...d.filters[f.key], min: v || undefined } } } : d))
                            }
                            keyboardType="decimal-pad"
                            placeholder="mín"
                          />
                          <Input
                            value={trackDraft.filters[f.key]?.max ?? ''}
                            onChangeText={(v) =>
                              setTrackDraft((d) => (d ? { ...d, filters: { ...d.filters, [f.key]: { ...d.filters[f.key], max: v || undefined } } } : d))
                            }
                            keyboardType="decimal-pad"
                            placeholder="máx"
                          />
                        </View>
                      </View>
                    ))}
                  </View>
                  <View style={styles.filterActions}>
                    <Btn label="Limpiar" variant="sm" onPress={() => setTrackDraft((d) => (d ? { ...d, filters: {} } : d))} />
                    <Btn label="Guardar" variant="sm" icon="check" onPress={() => saveTrack(trackDraft)} />
                    <Text style={styles.detailHint}>MC en miles: 150 = $150.000.</Text>
                  </View>
                </Card>
              ) : null}

              {track?.status && !track.status.gate.ok ? (
                <Banner kind="err">
                  {[
                    !track.status.gate.proxy.ok ? 'Poné el proxy propio del track (no el de FOMO/Photon) en Filtros' : null,
                    !track.status.gate.filters.ok ? 'poné al menos un filtro de Track' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}{' '}
                  — hasta entonces el track no arranca.
                </Banner>
              ) : null}

              {track?.status ? (
                <Text style={styles.detailHint}>
                  {track.status.enabled
                    ? track.status.lastFetchAt
                      ? `Último pull ${timeOf(track.status.lastFetchAt)} · ${track.status.counts.visible} tokens en Graduated ahora`
                      : 'Esperando el primer pull del server…'
                    : 'Trackeo pausado — activá el switch.'}
                  {track.status.lastError ? ` · error: ${track.status.lastError.message}` : ''}
                </Text>
              ) : null}

              {track && track.tokens.length > 0 ? (
                <View style={styles.search}>
                  <Icon name="search" size={16} color={Palette.textTertiary} />
                  <TextInput
                    value={trackQuery}
                    onChangeText={setTrackQuery}
                    placeholder="Buscar por símbolo o nombre…"
                    placeholderTextColor={Palette.textTertiary}
                    autoCorrect={false}
                    style={styles.searchInput}
                    accessibilityLabel="Buscar tokens trackeados por símbolo o nombre"
                  />
                </View>
              ) : null}

              {track && track.tokens.length > 1 ? (
                <View style={styles.trackSort}>
                  <Text style={styles.rowSub}>Ordenar</Text>
                  <SegTabs
                    options={[{ value: 'recent', label: 'Reciente' }, { value: 'gain', label: 'Ganancia' }]}
                    value={trackSort}
                    onChange={setTrackSort}
                    style={{ flex: 1 }}
                  />
                </View>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            track === null ? (
              <View style={{ gap: 6 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={56} />)}</View>
            ) : trackQuery.trim() && track.tokens.length > 0 ? (
              <Card style={{ padding: 16 }}>
                <Empty title="No hay tokens que coincidan" body="Probá con otro símbolo o nombre." />
              </Card>
            ) : (
              <Card style={{ padding: 16 }}>
                <Empty
                  title="Sin tokens trackeados"
                  body="El server le pide a Photon la columna Graduated con tus filtros (los mismos parámetros que la página Photon) y les saca un snapshot por minuto, hasta 50 por token."
                />
              </Card>
            )
          }
          renderItem={({ item }) =>
            item.kind === 'header' ? (
              <Text style={styles.dayHeader}>
                {item.group === 'active' ? `Trackeando · ${item.count}` : `Terminados (50/50) · ${item.count}`}
              </Text>
            ) : (
              <TrackRow
                t={item.t}
                open={expandedTrack === item.t.address}
                detail={expandedTrack === item.t.address ? trackDetail[item.t.address] : undefined}
                snapshotMax={track?.status?.snapshotMax ?? 50}
                onToggle={toggleTrackRow}
              />
            )
          }
        />
      ) : (
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {banner ? <Text style={styles.banner}>{banner.text}</Text> : null}

        <View style={styles.filters}>
          <SegTabs
            value={mode}
            onChange={setMode}
            options={[
              { value: 'trades' as HistoryMode, label: 'Trades' },
              { value: 'alerts' as HistoryMode, label: 'Alertas' },
              { value: 'track' as HistoryMode, label: 'Track' },
            ]}
          />
        </View>

        {mode === 'trades' ? (
        !user ? (
          <Card style={{ padding: 16, gap: 10 }}>
            <Empty title="Sign in to see your history" body="Every simulated fill lands here, newest first." />
            <Btn label="Go to Trade" variant="setup" onPress={() => router.push('/trade')} />
          </Card>
        ) : (
          <>
            <View style={styles.filters}>
              <SegTabs
                value={side}
                onChange={setSide}
                options={[
                  { value: '' as SideFilter, label: 'All' },
                  { value: 'BUY' as SideFilter, label: 'Buys' },
                  { value: 'SELL' as SideFilter, label: 'Sells' },
                ]}
              />
            </View>

            <View style={styles.search}>
              <Icon name="search" size={16} color={Palette.textTertiary} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search a ticker…"
                placeholderTextColor={Palette.textTertiary}
                autoCapitalize="characters"
                autoCorrect={false}
                style={styles.searchInput}
                accessibilityLabel="Search by ticker"
              />
            </View>

            {visible === null ? (
              <View style={{ gap: 6 }}>
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} height={56} />
                ))}
              </View>
            ) : !visible.length ? (
              <Card style={{ padding: 16 }}>
                <Empty
                  title={side || query ? 'No trades match' : 'No paper trades yet'}
                  body={side || query ? 'Try a different ticker or filter.' : 'Your buys and sells show up here, newest first.'}
                />
              </Card>
            ) : (
              <View style={{ gap: 6 }}>
                {visible.map((t, i) => {
                  const day = dayLabel(t.timestamp);
                  const previousDay = i > 0 ? dayLabel(visible[i - 1].timestamp) : null;
                  const isBuy = t.side === 'BUY';
                  const open = expanded === t.id;
                  const rowTone = isBuy ? '' : tone(t.realizedPnl);
                  return (
                    <View key={t.id}>
                      {day !== previousDay ? <Text style={styles.dayHeader}>{day}</Text> : null}
                      <View style={[styles.row, { backgroundColor: toneTint(rowTone as 'profit' | 'loss' | '') }]}>
                        <Pressable onPress={() => setExpanded(open ? null : t.id)} style={styles.rowMain} accessibilityRole="button">
                          <TokenAvatar symbol={t.symbol} chainId={t.chainId} address={t.address} size={34} />
                          <View style={styles.rowLead}>
                            <Text style={styles.rowName}>{t.symbol ?? '?'}</Text>
                            <Text style={styles.rowSub}>
                              <Text style={[styles.sideVerb, { color: isBuy ? Palette.green : Palette.red }]}>
                                {isBuy ? 'Bought' : 'Sold'}
                              </Text>{' '}
                              {formatCompactQty(t.quantity)} at {formatPrice(t.executionPrice)}
                            </Text>
                          </View>
                          <View style={styles.rowValue}>
                            <Text style={styles.rowMainValue}>{formatUsd(t.total)}</Text>
                            <Text style={[styles.rowSubValue, { color: t.realizedPnl === null ? Palette.textTertiary : toneColor(t.realizedPnl) }]}>
                              {t.realizedPnl === null ? timeOf(t.timestamp) : formatUsd(t.realizedPnl, { sign: true })}
                            </Text>
                          </View>
                          <Icon
                            name="chevron"
                            size={13}
                            color={Palette.textTertiary}
                            style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
                          />
                        </Pressable>

                        {open ? (
                          <View style={styles.detail}>
                            <DetailRow label="Time" value={new Date(t.timestamp).toLocaleString()} />
                            <DetailRow label="Requested" value={formatUsd(t.requestedValue)} />
                            <DetailRow label="Market price" value={formatPrice(t.marketPrice)} />
                            <DetailRow label="Fill price" value={formatPrice(t.executionPrice)} />
                            <DetailRow label="Simulated fee" value={formatUsd(t.fee)} />
                            <DetailRow label="Simulated slippage" value={formatUsd(t.slippage)} />
                            <DetailRow label="Cash after" value={formatUsd(t.cashAfter)} />
                            <DetailRow label="Liquidity" value={formatCompactUsd(t.liquidityUsd)} />
                            <DetailRow label="Market cap" value={formatCompactUsd(t.marketCapUsd)} />
                            <DetailRow label="Position" value={t.status === 'closed' ? 'Closed' : 'Still open'} />
                          </View>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )
        ) : mode === 'alerts' ? (
        alerts === null ? (
          <View style={{ gap: 6 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={56} />)}</View>
        ) : !alerts.length ? (
          <Card style={{ padding: 16 }}>
            <Empty title="Sin notificaciones todavía" body="Se disparan con los filtros de FOMO y Photon — lo que ves en esas listas es lo que te avisa." />
          </Card>
        ) : (
          <>
            <View style={styles.search}>
              <Icon name="search" size={16} color={Palette.textTertiary} />
              <TextInput
                value={alertQuery}
                onChangeText={setAlertQuery}
                placeholder="Buscar símbolo o nombre…"
                placeholderTextColor={Palette.textTertiary}
                autoCorrect={false}
                style={styles.searchInput}
                accessibilityLabel="Buscar alertas por símbolo o nombre"
              />
            </View>

            {!visibleAlerts?.length ? (
              <Card style={{ padding: 16 }}>
                <Empty title="No hay alertas que coincidan" body="Probá con otro símbolo o nombre." />
              </Card>
            ) : (
              <View style={{ gap: 6 }}>
                {visibleAlerts.map((entry, i) => {
                  const day = dayLabel(entry.notified_at);
                  const previousDay = i > 0 ? dayLabel(visibleAlerts[i - 1].notified_at) : null;
                  return (
                    <View key={entry.id}>
                      {day !== previousDay ? <Text style={styles.dayHeader}>{day}</Text> : null}
                      <Pressable
                        onPress={() => router.push(alertDeepLink(entry) as never)}
                        style={({ pressed }) => [styles.row, styles.alertRow, pressed && { backgroundColor: Palette.bgTertiarySolid }]}>
                        <TokenAvatar
                          symbol={entry.symbol}
                          chainId={entry.chain === 'sol' ? 'solana' : entry.chain}
                          address={entry.address}
                          size={34}
                        />
                        <View style={styles.rowLead}>
                          <Text style={styles.rowName}>{entry.symbol ?? entry.name ?? 'Token'}</Text>
                          <Text style={styles.rowSub}>
                            {ALERT_LABELS[entry.category] ?? entry.category}
                            {entry.mcap != null ? ` · ${formatCompactUsd(entry.mcap)} MC` : ''}
                          </Text>
                        </View>
                        {/* Exact time, not "10m ago" — the alert feed is read as a timeline.
                            rowSubValue has no color (trades pass the PnL tone inline), so set one here. */}
                        <Text style={[styles.rowSubValue, { color: Palette.textSecondary }]}>{timeOf(entry.notified_at)}</Text>
                        <Icon name="chevron" size={13} color={Palette.textTertiary} style={{ transform: [{ rotate: '-90deg' }] }} />
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )
        ) : null}
      </ScrollView>
      )}
    </SafeAreaView>
  );
}

/**
 * One tracked row — memoized on purpose: the poll hands over the SAME object
 * for tokens whose data didn't change, so only the rows that actually moved
 * re-render. Everything it paints is a prop; nothing is read from closures.
 */
const TrackRow = memo(function TrackRow({
  t,
  open,
  detail,
  snapshotMax,
  onToggle,
}: {
  t: TrackTokenSummary;
  open: boolean;
  detail?: TrackTokenDetail;
  snapshotMax: number;
  onToggle: (address: string) => void;
}) {
  return (
    <View style={styles.row}>
      <Pressable onPress={() => onToggle(t.address)} style={styles.rowMain} accessibilityRole="button">
        <TokenAvatar
          symbol={t.symbol}
          chainId={t.chain === 'sol' ? 'solana' : t.chain}
          address={t.address}
          logo={t.logo}
          size={34}
        />
        <View style={styles.rowLead}>
          <View style={styles.rowNameLine}>
            <Text style={styles.rowName} numberOfLines={1}>
              {t.symbol ?? t.name ?? `${t.address.slice(0, 4)}…`}
            </Text>
            {/* SCORE chico-y-tranquilo al lado del símbolo — reemplazó a las
                señales viejas (COMPRAR/EVITAR/health): esas no discriminaban
                (verde cerraba peor que rojo en 145 tokens). */}
            {t.buyScore != null ? (
              <View style={[styles.health, { backgroundColor: `${scoreTone(t.buyScore)}22`, borderColor: scoreTone(t.buyScore) }]}>
                <Text style={[styles.healthText, { color: scoreTone(t.buyScore) }]}>SCORE {t.buyScore}</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.rowSub}>
            MC {formatCompactUsd(t.mcap)} · VOL {formatCompactUsd(t.volume)}
            {t.gainPct != null ? (
              <Text style={{ color: t.gainPct >= 0 ? Palette.green : Palette.red }}>
                {' · '}
                {formatPct(t.gainPct, { sign: true })}
              </Text>
            ) : null}
          </Text>
          <View style={styles.rowAddr}>
            <Text style={styles.addrText}>
              {t.snapshotCount}/{snapshotMax} snaps
            </Text>
            <Text style={styles.addrText} selectable>
              {`${t.address.slice(0, 4)}…${t.address.slice(-4)}`}
            </Text>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Ver el token en GMGN"
              onPress={() => void WebBrowser.openBrowserAsync(`https://gmgn.ai/sol/token/${encodeURIComponent(t.address)}`)}
              hitSlop={8}
              style={styles.gmgn}>
              <Text style={styles.gmgnText}>GMGN</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.rowValue}>
          <Text
            style={[
              styles.rowMainValue,
              // Tres estados, no dos: "Activo" es capturando AHORA (en la
              // columna), "Pausado" salió de ella y "Cortado" llegó al tope
              // de 50 snapshots — antes un pausado se veía verde igual.
              { color: t.status !== 'active' ? Palette.textSecondary : t.visible ? Palette.green : Palette.warning },
            ]}>
            {t.status !== 'active' ? 'Cortado' : t.visible ? 'Activo' : 'Pausado'}
          </Text>
          <Text style={[styles.rowSubValue, { color: Palette.textTertiary }]}>{timeOf(t.lastSeenAt)}</Text>
        </View>
        <Icon name="chevron" size={13} color={Palette.textTertiary} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
      </Pressable>
      {open ? <TrackDetail detail={detail} /> : null}
    </View>
  );
});

/**
 * Expanded track row — the token's WHOLE snapshot series (newest first, minute
 * by minute). The server caps it at 50 snapshots per token, so "all of it" is a
 * bounded list: no pagination, no extra request (the detail endpoint already
 * ships the full series with the per-minute health chip).
 */
function TrackDetail({ detail }: { detail?: TrackTokenDetail }) {
  if (!detail) return <Text style={styles.detailHint}>Cargando snapshots…</Text>;
  const snaps = detail.snapshots;
  if (!snaps.length) {
    return <Text style={styles.detailHint}>Sin snapshots todavía — el track sigue abierto; captura cuando vuelva a Graduated.</Text>;
  }
  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  const pct = (v: number | null) => (v == null ? '—' : formatPct(v, { sign: false }));
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLine}>
        {snaps.length} snapshots · {formatDateTime(first.at)} → {formatDateTime(last.at)}
      </Text>
      {/* La línea de estado: SCORE manda; el "flujo compras/ventas" se quitó
          a petición (débil en el análisis) — queda holdersΔ + vol/mcap. */}
      <Text
        style={[
          styles.detailLine,
          { color: detail.buyScore != null ? scoreTone(detail.buyScore) : Palette.textSecondary },
        ]}>
        {detail.buyScore != null ? `SCORE ${detail.buyScore}/6 · ` : ''}holders{' '}
        {detail.holdersDeltaPct == null ? '—' : formatPct(detail.holdersDeltaPct, { sign: true })}
        {detail.turnover != null ? ` · vol/mcap ${detail.turnover.toFixed(1)}x` : ''}
      </Text>
      {/* Full series (≤ the 50-snapshot cap), newest first. A COPY before
          reverse(): reversing the prop in place flips first/last on re-render. */}
      {[...snaps]
        .reverse()
        .map((s) => (
          <View key={s.at} style={styles.snapRow}>
            {/* Columna de la hora: 24h arriba + chips de Pulse/Azura debajo;
                las métricas de Photon siguen SEPARADAS en su propia columna. */}
            <View style={styles.snapTimeCol}>
              <Text style={styles.snapTime}>{time24(s.at)}</Text>
              {/* Los chips de señal/health del minuto se quitaron: con 145
                  tokens no discriminaban (verde cerraba peor que rojo). El
                  SCORE de cada minuto vive en la fila de fuentes. */}
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <View style={styles.chipRow}>
                <MiniStat label="MC" value={formatCompactUsd(s.mcap)} labelTone={Palette.paper} />
                <MiniStat label="VOL" value={formatCompactUsd(s.volume)} labelTone={Palette.warning} />
                <MiniStat icon="users" value={formatCompactQty(s.holders)} tone={Palette.textSecondary} />
                {/* ↑ compras / ↓ ventas quitadas a petición: solo contexto,
                    no discriminaban en el análisis. Siguen en el snapshot. */}
              </View>
              <View style={styles.chipRow}>
                <MiniStat icon="crown" value={pct(s.topHoldersPct)} tone={Palette.warning} />
                {/* fresh% y snipers% quitados: muertos en el análisis
                   (snipers ρ≈0 / mejor regla lift 1.1; fresh 45% con n=11).
                   Los campos siguen en el snapshot. */}
                <MiniStat icon="package" value={pct(s.bundlePct)} sub={formatCompactQty(s.bundleHolders)} tone={Palette.paper} />
                <MiniStat icon="cpu" value={formatCompactQty(s.tpHolders)} tone={Palette.warning} />
              </View>
              {/* Métricas Pulse + Azura — con las demás métricas, no con la hora */}
              <SourceChips s={s} />
            </View>
          </View>
        ))}
    </View>
  );
}

/** Icon + value chip for the snapshot rows — 🖥 bots, 👥 holders, … */
function MiniStat({
  icon,
  img,
  label,
  value,
  sub,
  tone,
  labelTone,
  valueTone,
}: {
  icon?: IconName;
  img?: ImageSource;
  label?: string;
  value: string;
  sub?: string;
  tone?: string;
  labelTone?: string;
  valueTone?: string;
}) {
  return (
    <View style={styles.chip}>
      {img ? <ExpoImage source={img} style={styles.chipImg} contentFit="cover" /> : null}
      {icon ? <Icon name={icon} size={11} color={tone ?? Palette.textTertiary} /> : null}
      {label ? <Text style={[styles.chipLabel, labelTone ? { color: labelTone } : null]}>{label}</Text> : null}
      <Text style={[styles.chipValue, valueTone ? { color: valueTone } : null]}>{value}</Text>
      {sub ? <Text style={styles.chipSub}>{sub}</Text> : null}
    </View>
  );
}

/** The extra sources per snapshot (Trenchers Pulse + Azura + fuentes sociales). */
type SourceFields = {
  insiderPct: number | null;
  smartTraderPct: number | null;
  proTraders: number | null;
  kolCount: number | null;
  creatorMints: number | null;
  creatorGraduated: number | null;
  overallSecurity: string | null;
  securityFlags: string[] | null;
  volChange5m: number | null;
  volChange1h: number | null;
  buyVol5m: number | null;
  sellVol5m: number | null;
  buyVol1h: number | null;
  sellVol1h: number | null;
  proTradersAz: number | null;
  thesesCount: number | null;
  thesesOpen: number | null;
  thesesUsd: number | null;
  thesesPnlAvg: number | null;
  thesesEntryMcap: number | null;
  chatMsgs: number | null;
  chatWallets: number | null;
  chatHoldersUsd: number | null;
  chatPnlAvg: number | null;
  chatKols: number | null;
  calloutsTotal: number | null;
  calloutsUsd: number | null;
  calloutsUpPct: number | null;
  calloutsEntryMcap: number | null;
  calloutsVerified: number | null;
  posHolders: number | null;
  posHoldersTotal: number | null;
  callout100: number | null;
  calloutLt100: number | null;
  callout100to500: number | null;
  callout500: number | null;
  topDaily: number | null;
  topWeekly: number | null;
  topMonthly: number | null;
  topTraderNames: string[] | null;
  buyScore: number | null;
};

/** Verde ≥3 · ámbar 2 · rojo ≤1 — el score chico-y-tranquilo del snapshot. */
function scoreTone(score: number) {
  return score >= 3 ? Palette.green : score === 2 ? Palette.warning : Palette.red;
}

/**
 * Icono del chip TESIS: el "top trade" por defecto de GMGN (el tile azul con
 * su logo). La URL original (gmgn.ai/static/img/fomo_top_trade_default.webp)
 * está tras Cloudflare y devuelve 403 al app, así que el PNG vive en el repo.
 */
const TESIS_ICON = require('@/assets/images/tesis-gmgn.png');

/**
 * Icono del chip CHAT: "gmgn-community-tab.png" de GMGN (pixel-art 32×32).
 * También sin texto — el icono identifica la métrica.
 */
const CHAT_ICON = require('@/assets/images/chat-gmgn.png');

/**
 * Iconos de los chips de rangos CAL: las cápsulas "lab" de GMGN — verde para
 * [$100,$500) (pumplab) y dorada para ≥$500 (pumplabamm). También sin texto.
 */
const CAL100_ICON = require('@/assets/images/cal100-gmgn.png');
const CAL500_ICON = require('@/assets/images/cal500-gmgn.png');

/**
 * Extra-source chips (SMART/INS/DEV, SCORE, FOMO theses, GMGN chat,
 * pump callouts, TOP traders) as ONE flowing row, so the metrics
 * column packs lines full instead of leaving half-empty rows. Timeline
 * only (the list card shows none of this). A token tracked before those
 * sources existed has all-null fields → renders nothing.
 */
function SourceChips({ s }: { s: SourceFields }) {
  const hasPulse =
    s.insiderPct != null ||
    s.smartTraderPct != null ||
    s.creatorMints != null ||
    s.creatorGraduated != null;
  const hasSocial =
    s.thesesCount != null ||
    s.chatMsgs != null ||
    s.chatWallets != null ||
    s.calloutsTotal != null ||
    s.callout100 != null ||
    s.callout100to500 != null ||
    s.callout500 != null ||
    s.buyScore != null ||
    s.topDaily != null ||
    s.topWeekly != null ||
    s.topMonthly != null;
  if (!hasPulse && !hasSocial) return null;
  return (
    <View style={styles.chipRow}>
      {s.smartTraderPct != null ? (
        <MiniStat label="SMART" value={formatPct(s.smartTraderPct, { sign: false })} valueTone={Palette.green} />
      ) : null}
      {s.insiderPct != null ? (
        <MiniStat label="INS" value={formatPct(s.insiderPct, { sign: false })} valueTone={Palette.paper} />
      ) : null}
      {/* PRO (Pulse) quitado: redundante con 🖥 bots (ρ 0.93) y débil (40%,
          lift 1.3). KOL quitado: muerto (36%, lift 1.2). */}
      {s.creatorMints != null || s.creatorGraduated != null ? (
        <MiniStat
          label="DEV"
          value={formatCompactQty(s.creatorMints ?? 0)}
          sub={s.creatorGraduated != null ? `→${formatCompactQty(s.creatorGraduated)}` : undefined}
          valueTone={Palette.warning}
        />
      ) : null}
      {/* Quitados de la UI tras el análisis de 53h/223 tokens: V5m/V1h/C-V
          (ritmo de volumen), ⚠ flags de seguridad (31%, lift 1.0), PRO·AZ
          (40%, no correlaciona), PRO, KOL, fresh%, snipers%. Los campos
          siguen en el snapshot para el análisis, solo no se pintan. */}
      {/* Fuentes sociales — en la UI SOLO el conteo. El resto (USD, PnL,
          entry MC, verificados…) se guarda en el snapshot para el análisis,
          pero no se pinta: menos ruido por fila. */}
      {/* SCORE 0-6 chico-y-tranquilo — la señal de compra (x2 monótono:
          0→21%, ≥2→68%, ≥3→73% sobre 145 tokens). */}
      {s.buyScore != null ? (
        <MiniStat label="SCORE" value={String(s.buyScore)} valueTone={scoreTone(s.buyScore)} />
      ) : null}
      {/* TESIS: SOLO el icono "top trade" azul de GMGN + conteo (sin texto
          — decisión del usuario; reconoce el icono). La URL original de GMGN
          está tras Cloudflare, por eso vive en el repo. */}
      {s.thesesCount != null ? (
        <MiniStat img={TESIS_ICON} value={formatCompactQty(s.thesesCount)} valueTone={Palette.paper} />
      ) : null}
      {/* CHAT: SOLO el icono + wallets únicas que escribieron (sin texto y
          sin conteo de mensajes — decisión del usuario). */}
      {s.chatWallets != null ? (
        <MiniStat img={CHAT_ICON} value={formatCompactQty(s.chatWallets)} valueTone={Palette.green} />
      ) : null}
      {/* Callouts de pump.fun por RANGO de plata metida: solo los iconos
          (cápsulas GMGN verde/dorada) + conteo, sin texto — y AMBOS números
          en amarillo (decisión del usuario). [$100,$500) y ≥$500 reemplazan
          en la UI a "≥$100" y "<$100" (los campos viejos siguen en el
          snapshot para análisis). TOP·D/W/M = top traders del ranking
          propio de pump.fun (rank ≤50 y ≥$100 comprados), separado por
          board — visible siempre que exista la métrica (0 = ninguno). */}
      {s.callout100to500 != null ? (
        <MiniStat img={CAL100_ICON} value={formatCompactQty(s.callout100to500)} valueTone={Palette.warning} />
      ) : null}
      {s.callout500 != null ? (
        <MiniStat img={CAL500_ICON} value={formatCompactQty(s.callout500)} valueTone={Palette.warning} />
      ) : null}
      {s.topDaily != null ? (
        <MiniStat label="TOP·D" value={formatCompactQty(s.topDaily)} valueTone={Palette.green} />
      ) : null}
      {s.topWeekly != null ? (
        <MiniStat label="TOP·W" value={formatCompactQty(s.topWeekly)} valueTone={Palette.paper} />
      ) : null}
      {s.topMonthly != null ? (
        <MiniStat label="TOP·M" value={formatCompactQty(s.topMonthly)} valueTone={Palette.warning} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Palette.bgPrimary },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6 },
  title: { fontSize: 22, fontWeight: '800', color: Palette.textPrimary },
  gear: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: Palette.bgSecondary },

  body: { padding: 14, gap: 10, paddingBottom: 32 },
  banner: { fontSize: 13, color: Palette.textSecondary },

  filters: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Palette.lineStrong,
    backgroundColor: Palette.bgSecondary,
    paddingHorizontal: 12,
  },
  searchInput: { flex: 1, color: Palette.textPrimary, fontSize: 14, paddingVertical: 9 },

  dayHeader: { fontSize: 12, fontWeight: '800', color: Palette.textTertiary, textTransform: 'uppercase', letterSpacing: 1, marginTop: 6 },

  row: { borderRadius: Radius.md, borderWidth: 1, borderColor: Palette.line, overflow: 'hidden' },
  // Alert rows paint their own background + padding (the trade rows get those from the
  // tone-tinted wrapper + rowMain), matching the cards the history had in Notificaciones.
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, backgroundColor: Palette.bgPrimary },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 },
  rowLead: { flex: 1, gap: 2, minWidth: 0 },
  rowName: { fontSize: 14, fontWeight: '800', color: Palette.textPrimary },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  rowSub: { fontSize: 12, color: Palette.textSecondary, fontVariant: ['tabular-nums'] },
  sideVerb: { fontWeight: '800' },
  rowValue: { alignItems: 'flex-end', gap: 1 },
  rowMainValue: { fontSize: 14, fontWeight: '800', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  rowSubValue: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },

  detail: { paddingHorizontal: 10, paddingBottom: 10, gap: 5, borderTopWidth: 1, borderTopColor: Palette.line, paddingTop: 8 },

  // Track tab — a filter panel like Photon's, plus the minute-by-minute series.
  trackTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  filterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filterField: { width: '47%', gap: 4 },
  filterLabel: { fontSize: 11, fontWeight: '700', color: Palette.textSecondary },
  filterPair: { flexDirection: 'row', gap: 6 },
  filterActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  detailHint: { fontSize: 11, color: Palette.textTertiary, lineHeight: 15 },
  detailLine: { fontSize: 11, color: Palette.textSecondary, fontVariant: ['tabular-nums'] },
  // Cada snapshot: columna de la hora (24h + chips de señal debajo) y, al
  // lado, la columna de métricas (Photon + Pulse + Azura) como siempre.
  snapRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingVertical: 4, borderTopWidth: 1, borderTopColor: Palette.line },
  // Finita: solo lo que mide el pill más ancho (SEGUIMIENTO ≈76) — el resto
  // del ancho es para las métricas, que es donde no caben.
  snapTimeCol: { width: 78, gap: 4 },
  snapTime: { fontSize: 11, fontWeight: '700', color: Palette.textSecondary, fontVariant: ['tabular-nums'] },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  chipImg: { width: 12, height: 12, borderRadius: 3 },
  chipLabel: { fontSize: 10, fontWeight: '500', color: Palette.textTertiary },
  chipValue: { fontSize: 12, fontWeight: '500', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  chipSub: { fontSize: 10, fontWeight: '400', color: Palette.textTertiary, fontVariant: ['tabular-nums'] },
  trackSort: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowAddr: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 },
  health: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, borderWidth: 1 },
  healthText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.4 },
  addrText: { fontSize: 10, color: Palette.textTertiary, fontVariant: ['tabular-nums'] },
  gmgn: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: Palette.paperT },
  gmgnText: { fontSize: 9, fontWeight: '800', color: Palette.paper, letterSpacing: 0.5 },
});
