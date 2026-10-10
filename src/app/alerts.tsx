// Notification settings — which categories alert, the alert history, and a test
// button that fires a synthetic alert through the real path (floating panel + push).
// Filters are NOT configured here: the feed screens own them (FOMO pushes both tabs,
// Photon its columns) and the server notifies on exactly what those screens show.

import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';

import { Icon } from '@/components/icons';
import { Banner, Btn, Card, Empty, SegTabs } from '@/components/ui';
import { Palette, Radius } from '@/constants/paper';
import { formatCompactUsd, timeAgo } from '@/lib/format';
import {
  ALERT_CATEGORIES,
  alertDeepLink,
  fetchHistory,
  loadConfig,
  pushAvailable,
  saveCategories,
  sendTestAlert,
  type AlertCategory,
  type AlertHistoryEntry,
} from '@/lib/notifications';
import { useApp } from '@/state/app';

const CATEGORY_LABELS: Record<AlertCategory, string> = {
  fomo_graduated: 'FOMO Grad.',
  fomo_trending: 'FOMO Trend.',
  photon_new: 'Photon New',
  photon_graduated: 'Photon Grad.',
};

export default function AlertsScreen() {
  const { settings, flash } = useApp();
  const [categories, setCategories] = useState<Record<AlertCategory, boolean>>({
    fomo_graduated: false,
    fomo_trending: false,
    photon_new: false,
    photon_graduated: false,
  });
  // Which category the "Probar alerta" button fires — the filters themselves live
  // on the feed screens.
  const [testing, setTesting] = useState<AlertCategory>('fomo_graduated');
  const [history, setHistory] = useState<AlertHistoryEntry[]>([]);
  const [registered, setRegistered] = useState(false);
  const [pushOk, setPushOk] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  // Load config + history whenever the server URL changes. State updates live inside the async
  // continuation (never the effect body) so a slow server can't cascade renders.
  useEffect(() => {
    let live = true;
    void (async () => {
      void pushAvailable().then((ok) => {
        if (live) setPushOk(ok);
      });
      const config = await loadConfig(settings.serverBase);
      if (!live) return;
      if (config.registered) {
        setRegistered(true);
        if (config.categories) setCategories((prev) => ({ ...prev, ...config.categories }));
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
    async (nextCats: Record<AlertCategory, boolean>) => {
      try {
        await saveCategories(settings.serverBase, nextCats);
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
    void persist(next);
  };

  const test = async () => {
    try {
      await sendTestAlert(settings.serverBase, testing);
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
        {!pushOk ? <Banner kind="ok">Push del sistema no disponible en Expo Go — las alertas te llegan con el panel flotante en la app. Con una development build se suma la push.</Banner> : null}

        <Card style={{ padding: 14, gap: 12 }}>
          <Text style={styles.groupTitle}>Categorías</Text>
          {ALERT_CATEGORIES.map((id) => (
            <View key={id} style={styles.row}>
              <View style={styles.rowLead}>
                <Text style={styles.rowTitle}>{CATEGORY_LABELS[id]}</Text>
                <Text style={styles.rowSub}>Te aviso cuando aparezca un token nuevo en ese feed.</Text>
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
          <Text style={styles.fine}>
            Los filtros no se configuran acá: son los de las pantallas FOMO y Photon. Se envían al server con cada cambio, y
            la alerta se dispara con exactamente los mismos — lo que ves en la lista es lo que te avisa.
          </Text>
        </Card>

        <Card style={{ padding: 14, gap: 10 }}>
          <Text style={styles.groupTitle}>Probar</Text>
          <SegTabs value={testing} onChange={setTesting} options={ALERT_CATEGORIES.map((id) => ({ value: id, label: CATEGORY_LABELS[id] }))} />
          <View style={styles.actions}>
            <Btn label="Probar alerta" variant="sm" icon="lightning" onPress={() => void test()} />
          </View>
          <Text style={styles.fine}>Dispara una alerta sintética por el camino real: panel flotante + push (development build).</Text>
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
            <Empty title="Sin alertas todavía" body="Cuando aparezca un token nuevo en un feed activo, queda acá." />
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
