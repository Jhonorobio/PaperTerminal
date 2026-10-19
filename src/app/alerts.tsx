// Notification settings — which categories alert this device, plus the Track entry
// alerts' thresholds. The alert history moved to the History tab ("Alertas"), where
// trades and alerts share one timeline.
// Filters are NOT configured here: the feed screens own them (FOMO pins its tab,
// the Track page owns its New/Graduated sets) and the server notifies on exactly
// what those screens show.

import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/icons';
import { Banner, Card } from '@/components/ui';
import { Palette } from '@/constants/paper';
import {
  ALERT_CATEGORIES,
  DEFAULT_ALERT_PARAMS,
  DEFAULT_CATEGORIES,
  loadConfig,
  pushAvailable,
  registerDevice,
  sanitizeAlertParams,
  saveCategories,
  type AlertCategory,
  type AlertParams,
} from '@/lib/notifications';
import { useApp } from '@/state/app';

const CATEGORY_LABELS: Record<AlertCategory, string> = {
  fomo_trending: 'FOMO Trend.',
  track_cal_chat: 'Track CAL+CHAT',
  track_chat_tesis: 'Track CHAT+TESIS',
  track_top: 'Track TOP·D',
  track_cal100_pos: 'Track CAL100+',
  track_holder_pos: 'Track HOLDER 1D/1W',
  track_holder_both: 'Track HOLDER 1D+1W',
  track_holder_top: 'Track HOLDER TOP50',
};

/**
 * Las reglas del Track se evalúan en el snapshot de ENTRADA del token (su primer
 * minuto) y disparan una vez por token. Los números son los medidos el 17/oct
 * sobre el dump de prod (486 tokens / 8.108 snapshots, pico vs precio de
 * entrada): ver TRACK_RULES en server/src/notify.js. CAL100+ y las tres de
 * holder son la excepción: no salen del snapshot de entrada (ver sus textos).
 */
const TRACK_SUBS: Partial<Record<AlertCategory, string>> = {
  track_cal_chat:
    'Entrada con CAL [$100-500) y chat ≥N wallets: n=28 → 96% sube después, 18% x2, pico mediano +30% a 10min. Confirma el "sube", no el x2.',
  track_chat_tesis: 'Entrada con chat ≥N wallets Y ≥M tesis: n=22 → 95% sube, 27% x2, +65% pico a 10min.',
  track_top:
    'TOP·D ≥N en la entrada: n=69 → 80% sube, 23% x2, +36% pico a 10min (y 32% x2 / +55% a 30min).',
  track_cal100_pos:
    'Avisa cada wallet con callout ≥$100 que entra al token y queda EN VERDE (1d o 1w de TODA su cartera) — la misma lectura que las entradas CAL100 del detalle. Sin umbral y por entrada, no por token: el mismo token avisa por 2, 3, … wallets (medido: ~28 avisos por hora de track).',
  track_holder_pos:
    'Holder ≥$100 de mint-positions (sin exigir callout) con 1D o 1W positivo en TODA su cartera. Sin umbral; una vez por wallet en cada token.',
  track_holder_both:
    'Holder ≥$100 con 1D y 1W positivos. Categoría aparte: si cumple las dos, con OR y AND encendidas llegan las dos notificaciones.',
  track_holder_top:
    'Holder ≥$100 que al aparecer estaba en el top 50 daily o weekly del board global de pump.fun (refresco cada 15 min). Se evalúa una sola vez: si entra al top después, no avisa.',
};

const PARAM_FIELDS: { key: keyof AlertParams; label: string; hint: string }[] = [
  { key: 'chatWalletsMin', label: 'Chat ≥', hint: 'wallets hablando del token' },
  { key: 'tesisMin', label: 'Tesis ≥', hint: 'tesis de FOMO' },
  { key: 'topMin', label: 'TOP·D ≥', hint: 'top traders del día' },
];

export default function AlertsScreen() {
  const { settings } = useApp();
  const [categories, setCategories] = useState<Record<AlertCategory, boolean>>({ ...DEFAULT_CATEGORIES });
  const [params, setParams] = useState<AlertParams>({ ...DEFAULT_ALERT_PARAMS });
  // Texto en edición de cada umbral: deja borrar el campo mientras se escribe y se
  // sanea (1..máximo) recién al salir — lo que se guarda siempre es un número válido.
  const [paramText, setParamText] = useState<Record<keyof AlertParams, string>>({
    chatWalletsMin: String(DEFAULT_ALERT_PARAMS.chatWalletsMin),
    tesisMin: String(DEFAULT_ALERT_PARAMS.tesisMin),
    topMin: String(DEFAULT_ALERT_PARAMS.topMin),
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
        const cats = config.categories;
        if (cats) {
          const merged = { ...DEFAULT_CATEGORIES, ...cats };
          setCategories(merged);
          const mergedParams = sanitizeAlertParams(config.params);
          setParams(mergedParams);
          setParamText({
            chatWalletsMin: String(mergedParams.chatWalletsMin),
            tesisMin: String(mergedParams.tesisMin),
            topMin: String(mergedParams.topMin),
          });
          // Migración: una categoría nueva que el server todavía no guarda se
          // sincroniza sola aquí — garantiza que lo que dice el switch es lo
          // que el server realmente va a emitir.
          if (ALERT_CATEGORIES.some((id) => !(id in cats))) {
            void saveCategories(settings.serverBase, merged, mergedParams).catch(() => {});
          }
        }
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
    async (nextCats: Record<AlertCategory, boolean>, nextParams: AlertParams) => {
      try {
        setPushRegError(await saveCategories(settings.serverBase, nextCats, nextParams));
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
    void persist(next, params);
  };

  /** Sanea el campo editado y lo persiste junto con el resto (se llama al salir del input). */
  const commitParam = (key: keyof AlertParams) => {
    const clean = sanitizeAlertParams({ ...params, [key]: Number(paramText[key]) });
    setParams(clean);
    setParamText((t) => ({ ...t, [key]: String(clean[key]) }));
    void persist(categories, clean);
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
                <Text style={styles.rowSub}>{TRACK_SUBS[id] ?? 'Te aviso cuando aparezca un token nuevo en ese feed.'}</Text>
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
            Los filtros no se configuran acá: FOMO usa los de su pestaña y el Track los suyos (Graduated y New, por
            separado). Se envían al server con cada cambio, y la alerta se dispara con exactamente los mismos — lo que ves
            en la lista es lo que te avisa.
          </Text>
          <Text style={styles.fine}>El historial de alertas vive ahora en la pestaña History → Alertas.</Text>
        </Card>

        <Card style={{ padding: 14, gap: 12 }}>
          <Text style={styles.groupTitle}>Umbrales del Track</Text>
          {PARAM_FIELDS.map(({ key, label, hint }) => (
            <View key={key} style={styles.row}>
              <View style={styles.rowLead}>
                <Text style={styles.rowTitle}>{label}</Text>
                <Text style={styles.rowSub}>{hint}</Text>
              </View>
              <TextInput
                value={paramText[key]}
                onChangeText={(t) => setParamText((prev) => ({ ...prev, [key]: t.replace(/[^0-9]/g, '') }))}
                onBlur={() => commitParam(key)}
                onSubmitEditing={() => commitParam(key)}
                keyboardType="number-pad"
                inputMode="numeric"
                returnKeyType="done"
                style={styles.input}
                accessibilityLabel={`${label} (${hint})`}
              />
            </View>
          ))}
          <Text style={styles.fine}>
            Se aplican a las 3 alertas de entrada del Track (CAL+CHAT, CHAT+TESIS y TOP·D) y son por
            dispositivo: el server guarda un valor para cada uno. Defaults = los medidos (chat 2, tesis 1, top 1). Esas 3 se
            evalúan en el snapshot de entrada del token y disparan una vez por token. CAL100+ no lleva umbral: avisa por cada
            wallet que el barrido deja en verde. Las 3 de holder (1D/1W, 1D+1W y TOP50) tampoco llevan umbral: se evalúan
            una vez por wallet ≥$100 dentro de cada token, y el top 50 usa el board global de pump.fun (refresco cada 15 min).
          </Text>
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

  input: {
    minWidth: 56,
    paddingHorizontal: 10,
    paddingVertical: 6,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '700',
    color: Palette.textPrimary,
    backgroundColor: Palette.bgSecondary,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Palette.lineStrong,
  },

  fine: { fontSize: 11, color: Palette.textTertiary, lineHeight: 15 },
});
