// Notification settings — which categories alert this device. The alert history moved to the
// History tab ("Alertas"), where trades and alerts share one timeline.
// Filters are NOT configured here: the feed screens own them (FOMO pushes both tabs,
// Photon its columns) and the server notifies on exactly what those screens show.

import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/icons';
import { Banner, Card } from '@/components/ui';
import { Palette } from '@/constants/paper';
import {
  ALERT_CATEGORIES,
  loadConfig,
  pushAvailable,
  registerDevice,
  saveCategories,
  type AlertCategory,
} from '@/lib/notifications';
import { useApp } from '@/state/app';

const CATEGORY_LABELS: Record<AlertCategory, string> = {
  fomo_graduated: 'FOMO Grad.',
  fomo_trending: 'FOMO Trend.',
  photon_new: 'Photon New',
  photon_graduated: 'Photon Grad.',
  track_buy: 'Track COMPRAR',
};

export default function AlertsScreen() {
  const { settings } = useApp();
  const [categories, setCategories] = useState<Record<AlertCategory, boolean>>({
    fomo_graduated: false,
    fomo_trending: false,
    photon_new: false,
    photon_graduated: false,
    track_buy: false,
  });
  const [registered, setRegistered] = useState(false);
  const [pushOk, setPushOk] = useState(true);
  // Whether the server holds a push token for this device — null until known. Without
  // it the push path is dead (panel-only), so the screen makes that visible.
  const [pushRegistered, setPushRegistered] = useState<boolean | null>(null);
  // Why registration left the server without a token (permission denied, getExpoPushTokenAsync
  // failure, rejected PUT…) — shown verbatim so the cause doesn't stay hidden.
  const [pushRegError, setPushRegError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Load config + history whenever the server URL changes. State updates live inside the async
  // continuation (never the effect body) so a slow server can't cascade renders.
  useEffect(() => {
    let live = true;
    void (async () => {
      void pushAvailable().then((ok) => {
        if (live) setPushOk(ok);
      });
      let config = await loadConfig(settings.serverBase);
      if (!live) return;
      if (config.registered) {
        setRegistered(true);
        if (config.categories) setCategories((prev) => ({ ...prev, ...config.categories }));
        // A freshly reinstalled build has no token on the server yet — register right
        // here so "Probar" always tests the real push path, not a stale state.
        if (config.hasPush === false) {
          setPushRegError(await registerDevice(settings.serverBase));
          config = await loadConfig(settings.serverBase);
          if (!live) return;
        } else {
          setPushRegError(null);
        }
        setPushRegistered(config.hasPush ?? null);
        setProblem(null);
      } else {
        setProblem(settings.serverBase ? 'El servidor no responde — ¿está corriendo?' : 'Configurá la URL del servidor en Settings.');
      }
    })();
    return () => {
      live = false;
    };
  }, [settings.serverBase]);

  const persist = useCallback(
    async (nextCats: Record<AlertCategory, boolean>) => {
      try {
        setPushRegError(await saveCategories(settings.serverBase, nextCats));
        setRegistered(true);
        setProblem(null);
        // The PUT registers the push token too — refresh so the banner reflects reality.
        setPushRegistered((await loadConfig(settings.serverBase)).hasPush ?? null);
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
        {pushOk && pushRegistered === false ? (
          <Banner kind="ok">
            Sin token push en el server — mientras tanto las alertas llegan solo por el panel flotante. Si acabás de instalar una build nueva, abrí la app de nuevo y volvé a esta pantalla.
          </Banner>
        ) : null}
        {pushOk && pushRegistered === false && pushRegError ? (
          <Banner kind="err">No se pudo registrar el token de push: {pushRegError}</Banner>
        ) : null}
        {pushOk && pushRegistered === true ? <Banner kind="ok">Push del sistema activa — token registrado ✓</Banner> : null}

        <Card style={{ padding: 14, gap: 12 }}>
          <Text style={styles.groupTitle}>Categorías</Text>
          {ALERT_CATEGORIES.map((id) => (
            <View key={id} style={styles.row}>
              <View style={styles.rowLead}>
                <Text style={styles.rowTitle}>{CATEGORY_LABELS[id]}</Text>
                <Text style={styles.rowSub}>
                  {id === 'track_buy'
                    ? 'Te aviso el minuto en que un token trackeado enciende la señal COMPRAR (bots<150, holders<300, snipers<1% —o bundle quieto si no hay dato—, mcap arriba).'
                    : 'Te aviso cuando aparezca un token nuevo en ese feed.'}
                </Text>
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
            la alerta se dispara con exactamente los mismos — lo que ves en la lista es lo que te avisa. La señal Track
            COMPRAR viene del análisis de los snapshots del tracker (Track → Filtros).
          </Text>
          <Text style={styles.fine}>El historial de alertas vive ahora en la pestaña History → Alertas.</Text>
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

  fine: { fontSize: 11, color: Palette.textTertiary, lineHeight: 15 },
});
