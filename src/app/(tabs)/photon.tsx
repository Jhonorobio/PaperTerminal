// Photon memescope — New / Graduated, live from the feed server's WS topic `memescope`.
// Photon's API challenges anything that isn't a real Chrome TLS fingerprint (CycleTLS),
// so the server owns that connection and pushes the columns here; the phone just renders.
// Filters apply to the pushed snapshot locally, so each column keeps its own set.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';

import { Icon } from '@/components/icons';
import { Btn, Card, Empty, Input, SegTabs } from '@/components/ui';
import { Palette, Radius } from '@/constants/paper';
import { formatCompactUsd, formatPct, pnlClass } from '@/lib/format';
import { addRecentAsset } from '@/lib/storage';
import { serverFeed, ServerFeed } from '@/lib/market/server-feed';
import { photonLogoUrl, setPhotonServerFilters } from '@/lib/server-base';
import { activePhotonFilterCount, applyPhotonFilters, normalizePhotonFilters, type RawPhotonFilters } from '@/lib/market/photon-filters';
import type { PhotonColumn, PhotonFilters, PhotonToken } from '@/lib/types';
import { useApp } from '@/state/app';

/** Photon's raw item → the app's token shape. */
function mapPhoton(item: { attributes?: Record<string, unknown> }, base: string): PhotonToken | null {
  const a = item?.attributes;
  const address = (a?.tokenAddress as string) || (a?.address as string);
  if (!address) return null;
  const liq = a?.cur_liq as { usd?: unknown } | undefined;
  // Photon sends numbers as strings ("3047.52", "0.0") and counts as numbers — Number() covers both.
  const num = (v: unknown) => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const image = str(a?.imgUrl);
  return {
    address,
    symbol: str(a?.symbol),
    name: str(a?.name),
    // Photon blocks hotlinking; the server proxies the bytes with its Referer.
    image: image ? photonLogoUrl(base, image) : null,
    mcap: num(a?.fdv),
    liquidity: num(liq?.usd),
    volume24h: num(a?.volume),
    buysCount: num(a?.buys_count),
    holdersCount: num(a?.holders_count),
    tpHoldersCount: num(a?.tp_holders_count),
    freshPct: num(a?.fresh_holding_perc),
    bundleHolders: num(a?.bundle_holders_count),
    bundlePct: num(a?.bundle_holding_perc),
    topHoldersPct: num((a?.audit as { top_holders_perc?: unknown } | undefined)?.top_holders_perc),
  };
}

function tokensOfColumn(snapshot: ReturnType<typeof serverFeed.memescopeSnapshot>, column: PhotonColumn, base: string): PhotonToken[] {
  const data = snapshot?.columns?.[column]?.data;
  if (!Array.isArray(data)) return [];
  const out: PhotonToken[] = [];
  for (const item of data) {
    const mapped = mapPhoton(item as { attributes?: Record<string, unknown> }, base);
    if (mapped) out.push(mapped);
  }
  return out;
}

const FILTER_FIELDS: { key: keyof PhotonFilters; label: string }[] = [
  { key: 'age', label: 'Edad (min)' },
  { key: 'mktCap', label: 'MC ($K)' },
  { key: 'holders', label: 'Holders' },
  { key: 'tpHolders', label: 'TP Holders' },
  { key: 'buys', label: 'Compras' },
  { key: 'freshPct', label: 'Fresh %' },
  { key: 'bundleHolders', label: 'Bundle Holders' },
  { key: 'bundlePct', label: 'Bundle %' },
];

function PhotonRow({ token, onPress }: { token: PhotonToken; onPress: () => void }) {
  const tone = pnlClass(null);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: Palette.bgTertiarySolid }]} accessibilityRole="button">
      {token.image ? (
        <ExpoImage source={{ uri: token.image }} style={styles.rowImage} contentFit="cover" transition={120} />
      ) : (
        <View style={[styles.rowImage, styles.rowImageFallback]}>
          <Text style={styles.rowInitial}>{(token.symbol ?? '?').slice(0, 1).toUpperCase()}</Text>
        </View>
      )}

      <View style={styles.rowLead}>
        <Text numberOfLines={1} style={styles.rowSymbol}>
          {token.symbol ?? `${token.address.slice(0, 4)}…`}
        </Text>
        <Text numberOfLines={1} style={styles.rowName}>
          {token.name ?? token.address}
        </Text>
        <Text style={styles.rowSub}>
          {token.holdersCount != null ? `${formatCompactUsd(token.holdersCount)} holders` : 'holders —'}
          {token.buysCount != null ? ` · ${token.buysCount} buys` : ''}
        </Text>
      </View>

      <View style={styles.rowRight}>
        <Text style={styles.rowMcap}>{token.mcap != null ? formatCompactUsd(token.mcap) : '—'}</Text>
        <Text style={[styles.rowChange, { color: tone === 'up' ? Palette.green : Palette.red }]}>
          {token.freshPct != null ? `fresh ${formatPct(token.freshPct, { sign: false })}` : ''}
        </Text>
        <Text style={styles.rowSub}>
          {token.liquidity != null ? `liq ${formatCompactUsd(token.liquidity)}` : ''}
          {token.bundlePct != null ? ` · bnd ${formatPct(token.bundlePct, { sign: false })}` : ''}
        </Text>
      </View>

      <Icon name="chevron" size={13} color={Palette.textTertiary} style={{ transform: [{ rotate: '-90deg' }] }} />
    </Pressable>
  );
}

export default function PhotonScreen() {
  const { flash, settings, updateSettings } = useApp();
  const [column, setColumn] = useState<PhotonColumn>('col1');
  // Each column keeps its own filters, persisted in settings so they survive app restarts.
  const rawByCol = useMemo(() => settings.photonFilters ?? { col1: {}, col3: {} }, [settings.photonFilters]);
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState(() => serverFeed.status());
  const [syncState, setSyncState] = useState<'idle' | 'sending' | 'ok' | 'error'>('idle');

  useEffect(() => {
    void ServerFeed.ensureConnected(settings.serverBase);
  }, [settings.serverBase]);

  useFocusEffect(
    useCallback(() => {
      const unsubscribe = serverFeed.subscribe(() => setTick((t) => t + 1));
      setStatus(serverFeed.status());
      const id = setInterval(() => setStatus(serverFeed.status()), 2000);
      return () => {
        unsubscribe();
        clearInterval(id);
      };
    }, []),
  );

  const raw = rawByCol[column];
  const filters = useMemo(() => normalizePhotonFilters(raw), [raw]);
  const activeCount = activePhotonFilterCount(filters);

  const snapshot = serverFeed.memescopeSnapshot();
  const tokens = useMemo(() => {
    void tick;
    const list = tokensOfColumn(snapshot, column, settings.serverBase);
    return applyPhotonFilters(list, filters);
  }, [snapshot, column, filters, tick, settings.serverBase]);

  // Photon is pulled, not streamed: the filters travel to the server, which re-queries
  // Photon and pushes only what passes. (The local filter above is the instant echo.)
  useEffect(() => {
    const id = setTimeout(() => {
      setSyncState(activeCount ? 'sending' : 'ok');
      setPhotonServerFilters(settings.serverBase, rawByCol as never)
        .then(() => setSyncState('ok'))
        .catch(() => setSyncState('error'));
    }, 400);
    return () => clearTimeout(id);
  }, [rawByCol, settings.serverBase, activeCount]);

  const patchCol = useCallback(
    (col: PhotonColumn, field: keyof PhotonFilters, side: 'min' | 'max', value: string) => {
      const next: Record<PhotonColumn, RawPhotonFilters> = {
        ...rawByCol,
        [col]: { ...rawByCol[col], [field]: { ...(rawByCol[col]?.[field] ?? {}), [side]: value.replace(/[^0-9.]/g, '') } },
      };
      void updateSettings({ photonFilters: next });
    },
    [rawByCol, updateSettings],
  );

  const dotColor = status.lastError ? Palette.red : status.connected ? Palette.green : Palette.textTertiary;
  const received = tokensOfColumn(snapshot, column, settings.serverBase).length;
  const statusText = useMemo(() => {
    if (!status.connected) {
      if (status.everConnected) return 'reconectando al servidor…';
      return status.lastError ?? 'conectando al servidor…';
    }
    const parts = [`${received} recibidos · ${tokens.length} visibles`];
    if (activeCount) parts.push(`filtro local (${activeCount})`);
    if (syncState === 'sending') parts.push('enviando filtros…');
    else if (syncState === 'error') parts.push('filtros: error');
    else if (syncState === 'ok' && activeCount) parts.push('filtros en el server ✓');
    return parts.join(' · ');
  }, [status, received, tokens.length, activeCount, syncState]);

  const openToken = useCallback(
    async (token: PhotonToken) => {
      await addRecentAsset({ chain: 'solana', address: token.address, symbol: token.symbol, source: 'url' });
      router.push('/trade');
      flash('ok', `${token.symbol ?? 'Token'} loaded in Trade.`);
    },
    [flash],
  );

  const renderItem = useCallback(
    ({ item }: { item: PhotonToken }) => <PhotonRow token={item} onPress={() => void openToken(item)} />,
    [openToken],
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Photon</Text>
        <View style={styles.statusPill}>
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
          <Text numberOfLines={1} style={styles.statusText}>
            {statusText}
          </Text>
        </View>
      </View>

      <View style={styles.tabsRow}>
        <SegTabs
          value={column}
          onChange={setColumn}
          options={[
            { value: 'col1' as PhotonColumn, label: 'New' },
            { value: 'col3' as PhotonColumn, label: 'Graduated' },
          ]}
        />
        <Btn label={activeCount ? `Filtros · ${activeCount}` : 'Filtros'} variant="sm" icon={activeCount ? 'check' : 'search'} onPress={() => setOpen((v) => !v)} />
      </View>

      {open ? (
        <Card style={styles.filters}>
          <View style={styles.filterGrid}>
            {FILTER_FIELDS.map((f) => (
              <View key={f.key} style={styles.filterField}>
                <Text style={styles.filterLabel}>{f.label}</Text>
                <View style={styles.filterPair}>
                  <Input
                    value={raw[f.key]?.min != null ? String(raw[f.key]?.min) : ''}
                    onChangeText={(v) => patchCol(column, f.key, 'min', v)}
                    keyboardType="decimal-pad"
                    placeholder="mín"
                  />
                  <Input
                    value={raw[f.key]?.max != null ? String(raw[f.key]?.max) : ''}
                    onChangeText={(v) => patchCol(column, f.key, 'max', v)}
                    keyboardType="decimal-pad"
                    placeholder="máx"
                  />
                </View>
              </View>
            ))}
          </View>
          <View style={styles.filterActions}>
            <Btn
              label="Limpiar"
              variant="sm"
              onPress={() => {
                const next = { ...rawByCol, [column]: {} };
                void updateSettings({ photonFilters: next });
              }}
            />
            <Text style={styles.filterHint}>Market cap en miles: 150 = $150.000. Cada columna guarda sus propios filtros.</Text>
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
            <Empty title="Cargando columna…" body="El servidor rota una columna por tick; en segundos aparece la lista." />
          ) : (
            <Empty title="Sin servidor" body="Configurá la URL de tu servidor de feeds en Settings para ver Photon." />
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
  filterField: { width: '47%', gap: 4 },
  filterLabel: { fontSize: 11, fontWeight: '700', color: Palette.textSecondary },
  filterPair: { flexDirection: 'row', gap: 6 },
  filterActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  filterHint: { flex: 1, fontSize: 11, color: Palette.textTertiary, lineHeight: 15 },

  list: { flex: 1 },
  listContent: { paddingHorizontal: 14, paddingBottom: 32, gap: 6 },

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
  rowSymbol: { fontSize: 14, fontWeight: '800', color: Palette.textPrimary },
  rowName: { fontSize: 11, color: Palette.textSecondary },
  rowSub: { fontSize: 10, color: Palette.textTertiary },

  rowRight: { alignItems: 'flex-end', gap: 1 },
  rowMcap: { fontSize: 13, fontWeight: '800', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  rowChange: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
