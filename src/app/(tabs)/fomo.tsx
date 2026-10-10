// FOMO (fomo.family) discovery feed — graduated + trending Solana tokens, live from the FOMO
// WebSocket. Two tabs over one connection, filters for age / market cap / KOLs / limit, and a
// tap that hands the token to the Trade screen. The feed client lives in `@/lib/market/fomo`.

import { useCallback, useEffect, useMemo, useState, memo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';

import { Icon } from '@/components/icons';
import { Btn, Card, Empty, Field, Input, SegTabs } from '@/components/ui';
import { Palette, Radius } from '@/constants/paper';
import { formatCompactUsd, formatPct, pnlClass } from '@/lib/format';
import { addRecentAsset } from '@/lib/storage';
import { serverFeed, ServerFeed } from '@/lib/market/server-feed';
import { pulseEnrich } from '@/lib/market/pulse';
import { activeFilterCount, ageMinutes, normalizeFilters, selectFomoTokens, type RawFilters } from '@/lib/market/fomo-filters';
import { setFomoServerFilters } from '@/lib/server-base';
import type { FomoFeedId, FomoFilters, FomoToken } from '@/lib/types';
import { useApp } from '@/state/app';

/** Age label shape: 17m, 3h, 2d. */
function ageLabel(minutes: number | null): string | null {
  if (minutes == null) return null;
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * Raw text fields → the normalized filter set, in the units everything downstream
 * shares: market cap typed in thousands ("150" = $150,000 → 150000), ages in
 * minutes. The local list applies it here and the server applies the very same
 * object to the feed read and to the alert gate.
 */
function buildFilters(raw: RawFilters): FomoFilters {
  const base = normalizeFilters(raw);
  if (raw.mcapMin) base.mcapMin = Number(raw.mcapMin) * 1000;
  if (raw.mcapMax) base.mcapMax = Number(raw.mcapMax) * 1000;
  return base;
}

/**
 * Memoized row: FOMO updates a handful of tokens per push, so only the rows whose token object
 * actually changed re-render — the other ~88 stay untouched (their objects never change).
 */
const FomoRow = memo(function FomoRow({ token, nowSec, onPress }: { token: FomoToken; nowSec: number; onPress: () => void }) {
  const tone = pnlClass(token.change24);
  const age = ageLabel(ageMinutes(token, nowSec));
  const changeColor = tone === 'up' ? Palette.green : tone === 'down' ? Palette.red : Palette.textSecondary;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: Palette.bgTertiarySolid }]}
      accessibilityRole="button"
      accessibilityLabel={`Trade ${token.symbol ?? token.address}`}>
      {token.image ? (
        <ExpoImage source={{ uri: token.image }} style={styles.rowImage} contentFit="cover" transition={120} />
      ) : (
        <View style={[styles.rowImage, styles.rowImageFallback]}>
          <Text style={styles.rowInitial}>{(token.symbol ?? '?').slice(0, 1).toUpperCase()}</Text>
        </View>
      )}

      <View style={styles.rowLead}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowSymbol}>{token.symbol ?? `${token.address.slice(0, 4)}…`}</Text>
          {token.rank != null ? <Text style={styles.rowRank}>#{token.rank + 1}</Text> : null}
          {token.launchpad ? <Text style={styles.rowBadge}>{token.launchpad}</Text> : null}
        </View>
        <Text numberOfLines={1} style={styles.rowName}>
          {token.name ?? token.address}
        </Text>
        <Text style={styles.rowSub}>
          {age ? `${age} old` : 'age —'}
          {token.vol24 != null ? ` · vol ${formatCompactUsd(token.vol24)}` : ''}
        </Text>
      </View>

      <View style={styles.rowRight}>
        <Text style={styles.rowMcap}>{token.mcap != null ? formatCompactUsd(token.mcap) : '—'}</Text>
        <Text style={[styles.rowChange, { color: changeColor }]}>{token.change24 != null ? formatPct(token.change24) : '—'}</Text>
        <Text style={styles.rowSub}>
          {token.holders != null ? `${formatCompactUsd(token.holders)} holders` : ''}
          {token.kolCount != null ? ` · ${token.kolCount} KOL` : ''}
        </Text>
      </View>

      <Icon name="chevron" size={13} color={Palette.textTertiary} style={{ transform: [{ rotate: '-90deg' }] }} />
    </Pressable>
  );
});

export default function FomoScreen() {
  const { flash, settings, updateSettings } = useApp();
  const [feed, setFeed] = useState<FomoFeedId>('graduated');
  // Each tab keeps its own filters, persisted in settings so they survive app restarts.
  const rawByFeed = useMemo(() => settings.fomoFilters ?? { graduated: {}, trending: {} }, [settings.fomoFilters]);
  const raw = rawByFeed[feed];
  const [open, setOpen] = useState(false);
  // The server feed is a singleton outside React; this counter re-renders on its pushes.
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState(() => serverFeed.status());
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  // One WS to the feed server carries both feeds (and alerts). The phone never
  // talks to FOMO directly anymore.
  useEffect(() => {
    void ServerFeed.ensureConnected(settings.serverBase);
  }, [settings.serverBase]);

  useFocusEffect(
    useCallback(() => {
      const unsubscribe = serverFeed.subscribe(() => setTick((t) => t + 1));
      setStatus(serverFeed.status());
      const id = setInterval(() => {
        setStatus(serverFeed.status());
        setNowSec(Math.floor(Date.now() / 1000));
      }, 2000);
      return () => {
        unsubscribe();
        clearInterval(id);
      };
    }, []),
  );

  const patchFeed = useCallback(
    (id: FomoFeedId, patch: Partial<RawFilters>) => {
      const next = { ...rawByFeed, [id]: { ...rawByFeed[id], ...patch } };
      void updateSettings({ fomoFilters: next });
    },
    [rawByFeed, updateSettings],
  );

  // Market cap is typed in thousands ($K): "150" means $150,000.
  const filters = useMemo(() => buildFilters(raw), [raw]);
  const activeCount = activeFilterCount(filters);

  // Both tabs' filters also travel to the server: FOMO's feed read and its alert gate
  // live there, so notifications fire on exactly what this screen shows. Debounced like
  // Photon's, and it runs once on mount — a restarted server gets them back on the next
  // app open, without anyone touching Settings.
  useEffect(() => {
    const id = setTimeout(() => {
      void setFomoServerFilters(settings.serverBase, {
        graduated: buildFilters(rawByFeed.graduated ?? {}),
        trending: buildFilters(rawByFeed.trending ?? {}),
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(id);
  }, [rawByFeed, settings.serverBase]);

  const tokens = useMemo(() => {
    // Re-read the singleton on every server push; tick is the re-render trigger.
    void tick;
    return selectFomoTokens(feed, serverFeed.tokens(feed === 'trending' ? 'fomo_trending' : 'fomo'), filters, nowSec);
  }, [feed, filters, nowSec, tick]);

  // Trending tokens carry no createdAt from FOMO — resolve their age (and the KOL count that comes
  // free in the same Pulse response) for the visible candidates. Graduated tokens already carry
  // it, so this only runs there. Filter bounds still force enrichment, same as before.
  useEffect(() => {
    const needsKol = filters.kolMin != null || filters.kolMax != null;
    const needsAge = filters.ageMinMin != null || filters.ageMaxMin != null;
    if (feed !== 'trending' && !needsKol && !needsAge) return;
    let live = true;
    const wide = selectFomoTokens(feed, serverFeed.tokens(feed === 'trending' ? 'fomo_trending' : 'fomo'), { ...filters, kolMin: undefined, kolMax: undefined }, nowSec).slice(0, 100);
    void pulseEnrich(wide, { kol: needsKol, age: true }).then((changed) => {
      if (live && changed > 0) setTick((t) => t + 1);
    });
    return () => {
      live = false;
    };
  }, [feed, filters, nowSec, tick]);

  const openToken = useCallback(
    async (token: FomoToken) => {
      await addRecentAsset({ chain: 'solana', address: token.address, symbol: token.symbol, source: 'url' });
      router.push('/trade');
      flash('ok', `${token.symbol ?? 'Token'} loaded in Trade.`);
    },
    [flash],
  );

  const liveCount = serverFeed.tokens(feed === 'trending' ? 'fomo_trending' : 'fomo').length;
  // Freshness: FOMO pushes are change-driven, so "datos hace Ns" climbs whenever the server's
  // upstream connection goes quiet — a green dot alone can't tell a live feed from a dead one.
  // 30s before red: quiet minutes happen; a dead feed looks exactly like a quiet one until then.
  const feedAt = serverFeed.fomoReceivedAt();
  const feedAgeSec = feedAt ? Math.max(0, nowSec - Math.floor(feedAt / 1000)) : null;
  const feedStale = feedAgeSec != null && feedAgeSec > 30;
  const dotColor = status.lastError || feedStale ? Palette.red : status.connected && feedAgeSec != null ? Palette.green : Palette.textTertiary;
  const statusText = !status.connected
    ? status.everConnected
      ? 'reconectando al servidor…'
      : status.lastError
        ? status.lastError
        : 'conectando al servidor…'
    : `live · ${liveCount} tokens${feedAgeSec == null ? '' : ` · datos hace ${feedAgeSec}s`}`;

  // Stable renderItem + memoized rows: a push only repaints the tokens that actually changed. The
  // age label is the one cell that ages on its own, so it re-renders from the row's own state.
  const renderItem = useCallback(
    ({ item }: { item: FomoToken }) => (
      <View style={styles.rowWrap}>
        <FomoRow token={item} nowSec={nowSec} onPress={() => void openToken(item)} />
      </View>
    ),
    [nowSec, openToken],
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>FOMO</Text>
        <View style={styles.statusPill}>
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
          <Text numberOfLines={1} style={styles.statusText}>
            {statusText}
          </Text>
        </View>
      </View>

      <View style={styles.tabsRow}>
        <SegTabs
          value={feed}
          onChange={setFeed}
          options={[
            { value: 'graduated' as FomoFeedId, label: `Graduados${serverFeed.tokens('fomo').length ? ` · ${serverFeed.tokens('fomo').length}` : ''}` },
            { value: 'trending' as FomoFeedId, label: `Trending${serverFeed.tokens('fomo_trending').length ? ` · ${serverFeed.tokens('fomo_trending').length}` : ''}` },
          ]}
        />
        <Btn
          label={activeCount ? `Filtros · ${activeCount}` : 'Filtros'}
          variant="sm"
          icon={activeCount ? 'check' : 'search'}
          onPress={() => setOpen((v) => !v)}
        />
      </View>

      {open ? (
        <Card style={styles.filters}>
          <View style={styles.filterGrid}>
            <Field label="Edad mín (min)">
              <Input value={raw.ageMinMin ?? ''} onChangeText={(v) => patchFeed(feed, { ageMinMin: v.replace(/[^0-9]/g, '') })} keyboardType="number-pad" placeholder="0" />
            </Field>
            <Field label="Edad máx (min)">
              <Input value={raw.ageMaxMin ?? ''} onChangeText={(v) => patchFeed(feed, { ageMaxMin: v.replace(/[^0-9]/g, '') })} keyboardType="number-pad" placeholder="∞" />
            </Field>
            <Field label="MC mín ($K)">
              <Input value={raw.mcapMin ?? ''} onChangeText={(v) => patchFeed(feed, { mcapMin: v.replace(/[^0-9]/g, '') })} keyboardType="number-pad" placeholder="0" />
            </Field>
            <Field label="MC máx ($K)">
              <Input value={raw.mcapMax ?? ''} onChangeText={(v) => patchFeed(feed, { mcapMax: v.replace(/[^0-9]/g, '') })} keyboardType="number-pad" placeholder="∞" />
            </Field>
            <Field label="KOL mín">
              <Input value={raw.kolMin ?? ''} onChangeText={(v) => patchFeed(feed, { kolMin: v.replace(/[^0-9]/g, '') })} keyboardType="number-pad" placeholder="0" />
            </Field>
            <Field label="KOL máx">
              <Input value={raw.kolMax ?? ''} onChangeText={(v) => patchFeed(feed, { kolMax: v.replace(/[^0-9]/g, '') })} keyboardType="number-pad" placeholder="∞" />
            </Field>
          </View>
          <Field label="Límite de resultados">
            <Input value={raw.limit ?? ''} onChangeText={(v) => patchFeed(feed, { limit: v.replace(/[^0-9]/g, '') })} keyboardType="number-pad" placeholder="200" />
          </Field>
          <View style={styles.filterActions}>
            <Btn label="Limpiar" variant="sm" onPress={() => patchFeed(feed, {})} />
            <Text style={styles.filterHint}>Market cap en miles: 150 = $150.000. El KOL y la edad se resuelven por token solo cuando filtrás por ellos.</Text>
          </View>
        </Card>
      ) : null}

      <FlatList
        data={tokens}
        keyExtractor={(t) => t.address}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          status.connected ? (
            <Empty title="Cargando el feed…" body="La lista completa llega al suscribirse; después se actualiza en vivo." />
          ) : (
            <Empty
              title={status.everConnected ? 'Reconectando…' : 'Sin servidor'}
              body="Configurá la URL de tu servidor de feeds en Settings (PC: http://192.168.x.x:8787 · prod: Railway) y abrilo."
            />
          )
        }
        renderItem={renderItem}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Palette.bgPrimary },

  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: '800', color: Palette.textPrimary },
  statusPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Palette.bgSecondary,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Palette.line,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { flex: 1, fontSize: 11, color: Palette.textSecondary },

  tabsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingBottom: 10 },

  filters: { marginHorizontal: 14, marginBottom: 10, padding: 12, gap: 10 },
  filterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filterActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  filterHint: { flex: 1, fontSize: 11, color: Palette.textTertiary, lineHeight: 15 },

  list: { flex: 1 },
  listContent: { paddingHorizontal: 14, paddingBottom: 32, gap: 6 },
  rowWrap: {},

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    backgroundColor: Palette.bgSecondary,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Palette.line,
  },
  rowImage: { width: 38, height: 38, borderRadius: 19, backgroundColor: Palette.bgTertiarySolid },
  rowImageFallback: { alignItems: 'center', justifyContent: 'center' },
  rowInitial: { fontSize: 15, fontWeight: '800', color: Palette.textSecondary },

  rowLead: { flex: 1, gap: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  rowSymbol: { fontSize: 14, fontWeight: '800', color: Palette.textPrimary },
  rowRank: { fontSize: 10, fontWeight: '800', color: Palette.paper },
  rowBadge: {
    fontSize: 9,
    fontWeight: '800',
    color: Palette.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    backgroundColor: Palette.bgTertiary,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  rowName: { fontSize: 11, color: Palette.textSecondary },
  rowSub: { fontSize: 10, color: Palette.textTertiary },

  rowRight: { alignItems: 'flex-end', gap: 1 },
  rowMcap: { fontSize: 13, fontWeight: '800', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  rowChange: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
