/**
 * Floating alert panel — the in-app mirror of a push notification. Lives above
 * every screen: the feed server broadcasts a matched alert to this device's
 * private topic, and the panel shows it wherever the user is. Tapping it opens
 * Trade with the token loaded.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Image as ExpoImage } from 'expo-image';

import { Icon } from '@/components/icons';
import { Palette, Radius } from '@/constants/paper';
import { formatCompactUsd } from '@/lib/format';
import { alertDeepLink, type AlertHistoryEntry } from '@/lib/notifications';
import { serverFeed, ServerFeed } from '@/lib/market/server-feed';
import { useApp } from '@/state/app';

const LABELS: Record<string, string> = {
  fomo_graduated: 'FOMO Graduados',
  fomo_trending: 'FOMO Trending',
  photon_new: 'Photon New',
  photon_graduated: 'Photon Graduated',
};

export function AlertOverlay() {
  const { settings } = useApp();
  const [entry, setEntry] = useState<AlertHistoryEntry | null>(null);

  useEffect(() => {
    void ServerFeed.ensureConnected(settings.serverBase);
  }, [settings.serverBase]);

  useEffect(() => {
    const unsubscribe = serverFeed.onAlert((data) => setEntry(data as AlertHistoryEntry));
    return unsubscribe;
  }, []);

  // Auto-dismiss; the entry stays in the server's history.
  useEffect(() => {
    if (!entry) return;
    const timer = setTimeout(() => setEntry(null), 7_000);
    return () => clearTimeout(timer);
  }, [entry]);

  if (!entry) return null;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <Pressable
        onPress={() => {
          setEntry(null);
          router.push(alertDeepLink(entry) as never);
        }}
        style={({ pressed }) => [styles.card, pressed && { backgroundColor: Palette.bgTertiarySolid }]}
        accessibilityRole="button">
        {entry.logo ? (
          <ExpoImage source={{ uri: entry.logo }} style={styles.image} contentFit="cover" transition={120} />
        ) : (
          <View style={[styles.image, styles.imageFallback]}>
            <Icon name="lightning" size={16} color={Palette.paper} />
          </View>
        )}
        <View style={styles.lead}>
          <Text style={styles.kicker}>{LABELS[entry.category] ?? entry.category}</Text>
          <Text style={styles.title}>
            {entry.symbol ?? 'Token'} {entry.mcap != null ? `· ${formatCompactUsd(entry.mcap)} MC` : ''}
          </Text>
          <Text style={styles.sub}>
            {[
              entry.liq != null ? `Liq ${formatCompactUsd(entry.liq)}` : null,
              entry.vol24h != null ? `Vol ${formatCompactUsd(entry.vol24h)}` : null,
              entry.kolCount != null ? `${entry.kolCount} KOL` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'Pasó tus filtros'}
          </Text>
        </View>
        <Pressable onPress={() => setEntry(null)} hitSlop={12} accessibilityLabel="Cerrar">
          <Icon name="close" size={14} color={Palette.textTertiary} />
        </Pressable>
      </Pressable>
      <Text style={styles.hint}>Toque para comerciar · paper trading</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 8, left: 12, right: 12, zIndex: 100 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    backgroundColor: Palette.bgSecondary,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Palette.paperLine,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  image: { width: 38, height: 38, borderRadius: 19, backgroundColor: Palette.bgTertiarySolid },
  imageFallback: { alignItems: 'center', justifyContent: 'center' },
  lead: { flex: 1, gap: 1, minWidth: 0 },
  kicker: { fontSize: 9, fontWeight: '800', color: Palette.paper, textTransform: 'uppercase', letterSpacing: 0.8 },
  title: { fontSize: 14, fontWeight: '800', color: Palette.textPrimary },
  sub: { fontSize: 11, color: Palette.textSecondary },
  hint: { fontSize: 10, color: Palette.textTertiary, textAlign: 'center', marginTop: 4 },
});
