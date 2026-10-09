// Notification settings — which categories alert, what each one must pass, the
// alert history, and a test button that fires a synthetic alert through the real
// path (floating panel + push).

import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';

import { Icon } from '@/components/icons';
import { Banner, Btn, Card, Empty, Input, SegTabs } from '@/components/ui';
import { Palette, Radius } from '@/constants/paper';
import { formatCompactUsd, timeAgo } from '@/lib/format';
import {
  ALERT_CATEGORIES,
  ALERT_FILTER_FIELDS,
  alertDeepLink,
  fetchHistory,
  loadConfig,
  saveCategories,
  sendTestAlert,
  type AlertCategory,
  type AlertFilterField,
  type AlertFilters,
  type AlertHistoryEntry,
  type AlertRange,
} from '@/lib/notifications';
import { useApp } from '@/state/app';

const CATEGORY_LABELS: Record<AlertCategory, string> = {
  fomo_graduated: 'FOMO Grad.',
  fomo_trending: 'FOMO Trend.',
  photon_new: 'Photon New',
  photon_graduated: 'Photon Grad.',
};

const FIELD_LABELS: Record<AlertFilterField, string> = {
  usd_market_cap: 'Market cap ($K)',
  liquidity: 'Liquidez ($)',
  volume_24h: 'Volumen 24h ($)',
  holders_count: 'Holders',
  kol_count: 'KOLs',
  age_minutes: 'Edad (min)',
};

const rangeText = (range: AlertRange | undefined, side: 'min' | 'max') => (range?.[side] != null ? String(range[side]) : '');
const numOrNull = (v: string): number | null => {
  const n = Number(v);
  return v.trim() && Number.isFinite(n) ? n : null;
};

export default function AlertsScreen() {
  const { settings, flash } = useApp();
  const [categories, setCategories] = useState<Record<AlertCategory, boolean>>({
    fomo_graduated: false,
    fomo_trending: false,
    photon_new: false,
    photon_graduated: false,
  });
  const [filters, setFilters] = useState<AlertFilters>({});
  const [editing, setEditing] = useState<AlertCategory>('fomo_graduated');
  const [history, setHistory] = useState<AlertHistoryEntry[]>([]);
  const [registered, setRegistered] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Load config + history whenever the server URL changes. State updates live inside the async
  // continuation (never the effect body) so a slow server can't cascade renders.
  useEffect(() => {
    let live = true;
    void (async () => {
      const config = await loadConfig(settings.serverBase);
      if (!live) return;
      if (config.registered) {
        setRegistered(true);
        if (config.categories) setCategories((prev) => ({ ...prev, ...config.categories }));
        if (config.filters) setFilters(config.filters);
        setProblem(null);
      } else {
        setProblem(settings.serverBase ? 'El servidor no responde — ¿está corriendo?' : 'Configurá la URL del servidor en Settings.');
      }
      setHistory(await fetchHistory(settings.serverBase));
    })();
    return () => {
      live = false;
    };
  }, [settings.serverBase]);

  const persist = useCallback(
    async (nextCats: Record<AlertCategory, boolean>, nextFilters: AlertFilters) => {
      try {
        await saveCategories(settings.serverBase, nextCats, nextFilters);
        setRegistered(true);
        setProblem(null);
      } catch (err) {
        setProblem(err instanceof Error ? err.message : 'No se pudo guardar.');
      }
    },
    [settings.serverBase],
  );

  const toggle = (id: AlertCategory, value: boolean) => {
    const next = { ...categories, [id]: value };
    setCategories(next);
    void persist(next, filters);
  };

  // The edited category's ranges, straight from the server's copy (no local draft to drift).
  const draft = filters[editing] ?? {};
  const setDraft = (next: Partial<Record<AlertFilterField, AlertRange>>) => {
    const clean: AlertFilters = { ...filters };
    const entries = Object.entries(next).filter(([, r]) => r && (r.min != null || r.max != null));
    if (entries.length) clean[editing] = Object.fromEntries(entries);
    else delete clean[editing];
    setFilters(clean);
    void persist(categories, clean);
  };

  const test = async () => {
    try {
      await sendTestAlert(settings.serverBase, editing);
      flash('ok', 'Alerta de prueba enviada — la vas a ver flotar arriba.');
      setHistory(await fetchHistory(settings.serverBase));
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'No se pudo enviar la prueba.');
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="Volver">
          <Icon name="chevron" size={18} color={Palette.textSecondary} style={{ transform: [{ rotate: '90deg' }] }} />
        </Pressable>
        <Text style={styles.title}>Notificaciones</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {problem ? <Banner kind="err">{problem}</Banner> : null}

        <Card style={{ padding: 14, gap: 12 }}>
          <Text style={styles.groupTitle}>Categorías</Text>
          {ALERT_CATEGORIES.map((id) => (
            <View key={id} style={styles.row}>
              <View style={styles.rowLead}>
                <Text style={styles.rowTitle}>{CATEGORY_LABELS[id]}</Text>
                <Text style={styles.rowSub}>Te aviso cuando un token nuevo pase tus filtros.</Text>
              </View>
              <Switch
                value={categories[id]}
                onValueChange={(v) => toggle(id, v)}
                trackColor={{ false: Palette.lineStrong, true: Palette.paperStrong }}
                thumbColor={Palette.textPrimary}
              />
            </View>
          ))}
          {!registered ? <Text style={styles.fine}>Al activar una categoría se registra este dispositivo para push.</Text> : null}
        </Card>

        <Card style={{ padding: 14, gap: 10 }}>
          <Text style={styles.groupTitle}>Filtros por categoría</Text>
          <SegTabs value={editing} onChange={setEditing} options={ALERT_CATEGORIES.map((id) => ({ value: id, label: CATEGORY_LABELS[id] }))} />

          {ALERT_FILTER_FIELDS.map((field) => (
            <View key={field} style={styles.filterRow}>
              <Text style={styles.filterLabel}>{FIELD_LABELS[field]}</Text>
              <View style={styles.filterInputs}>
                <Input
                  value={rangeText(draft[field], 'min')}
                  onChangeText={(v) => setDraft({ ...draft, [field]: { ...draft[field], min: numOrNull(v) } })}
                  keyboardType="decimal-pad"
                  placeholder="mín"
                />
                <Input
                  value={rangeText(draft[field], 'max')}
                  onChangeText={(v) => setDraft({ ...draft, [field]: { ...draft[field], max: numOrNull(v) } })}
                  keyboardType="decimal-pad"
                  placeholder="máx"
                />
              </View>
            </View>
          ))}
          <View style={styles.actions}>
            <Btn label="Probar alerta" variant="sm" onPress={() => void test()} />
          </View>
          <Text style={styles.fine}>
            Los cambios se guardan solos. Market cap en miles: 150 = $150.000. Un token sin el dato de un filtro que usás,
            queda fuera.
          </Text>
        </Card>

        <Card style={{ padding: 14, gap: 8 }}>
          <Text style={styles.groupTitle}>Historial</Text>
          {history.length ? (
            history.map((entry) => (
              <Pressable
                key={entry.id}
                onPress={() => router.push(alertDeepLink(entry) as never)}
                style={({ pressed }) => [styles.histRow, pressed && { backgroundColor: Palette.bgTertiarySolid }]}>
                {entry.logo ? (
                  <ExpoImage source={{ uri: entry.logo }} style={styles.histImage} contentFit="cover" />
                ) : (
                  <View style={[styles.histImage, styles.histImageFallback]}>
                    <Text style={styles.histInitial}>{(entry.symbol ?? '?').slice(0, 1)}</Text>
                  </View>
                )}
                <View style={styles.rowLead}>
                  <Text style={styles.rowTitle}>
                    {entry.symbol ?? 'Token'} {entry.mcap != null ? `· ${formatCompactUsd(entry.mcap)}` : ''}
                  </Text>
                  <Text style={styles.rowSub}>
                    {entry.category.replace('_', ' ')} · {timeAgo(entry.notified_at)}
                  </Text>
                </View>
                <Icon name="chevron" size={13} color={Palette.textTertiary} style={{ transform: [{ rotate: '-90deg' }] }} />
              </Pressable>
            ))
          ) : (
            <Empty title="Sin alertas todavía" body="Cuando un token pase tus filtros, queda acá." />
          )}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Palette.bgPrimary },

  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  title: { fontSize: 22, fontWeight: '800', color: Palette.textPrimary },

  body: { padding: 14, gap: 10, paddingBottom: 32 },
  groupTitle: { fontSize: 12, fontWeight: '800', color: Palette.textSecondary, textTransform: 'uppercase', letterSpacing: 1 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowLead: { flex: 1, gap: 1, minWidth: 0 },
  rowTitle: { fontSize: 14, fontWeight: '700', color: Palette.textPrimary },
  rowSub: { fontSize: 11, color: Palette.textTertiary },

  filterRow: { gap: 4 },
  filterLabel: { fontSize: 11, fontWeight: '700', color: Palette.textSecondary },
  filterInputs: { flexDirection: 'row', gap: 8 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  fine: { fontSize: 11, color: Palette.textTertiary, lineHeight: 15 },

  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    backgroundColor: Palette.bgPrimary,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Palette.line,
  },
  histImage: { width: 32, height: 32, borderRadius: 16, backgroundColor: Palette.bgTertiarySolid },
  histImageFallback: { alignItems: 'center', justifyContent: 'center' },
  histInitial: { fontSize: 13, fontWeight: '800', color: Palette.textSecondary },
});
