import { StyleSheet, Text, View } from 'react-native';

import { Palette } from '@/constants/paper';
import type { TrackBuySignal, TrackHealth } from '@/lib/track';

/**
 * The health chip the tracker computes from a token's snapshot series — the same
 * pill the Track tab shows, now wherever the token shows up (Trade, FOMO,
 * Photon). Renders NOTHING when the token isn't tracked: there is no series to
 * read, and a chip without data would be a guess.
 */
export const HEALTH_META: Record<Exclude<TrackHealth, null>, { label: string; color: string }> = {
  green: { label: 'Sostenible', color: Palette.green },
  amber: { label: 'Duda', color: Palette.warning },
  red: { label: 'Distribuye', color: Palette.red },
};

/**
 * The BUY signal chip — "¿compro?" answered from the entry profile + minute-3
 * momentum (validated at the minute-3 price, not the entry price). 'buy' renders
 * as a solid call to act; 'avoid' as an explicit warning. null renders nothing.
 */
export const BUY_META: Record<Exclude<TrackBuySignal, null>, { label: string; color: string }> = {
  buy: { label: 'COMPRAR', color: Palette.green },
  avoid: { label: 'EVITAR', color: Palette.red },
};

/** COMPRAR FUERTE = señal COMPRAR + bundle quieto (la celda más fuerte medida). */
export const STRONG_BUY_LABEL = '★COMPRAR';

export function TrackBuyChip({ buySignal, strong = false }: { buySignal: TrackBuySignal; strong?: boolean }) {
  if (!buySignal) return null;
  const meta = BUY_META[buySignal];
  const solid = buySignal === 'buy';
  const label = solid && strong ? STRONG_BUY_LABEL : meta.label;
  return (
    <View
      style={[
        styles.chip,
        { backgroundColor: solid ? meta.color : `${meta.color}22`, borderColor: meta.color },
      ]}
    >
      <Text style={[styles.text, { color: solid ? Palette.bgPrimary : meta.color }]}>{label}</Text>
    </View>
  );
}

export function TrackHealthChip({ health }: { health: TrackHealth }) {
  if (!health) return null;
  const meta = HEALTH_META[health];
  return (
    <View style={[styles.chip, { backgroundColor: `${meta.color}22`, borderColor: meta.color }]}>
      <Text style={[styles.text, { color: meta.color }]}>{meta.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, borderWidth: 1, alignSelf: 'center' },
  text: { fontSize: 9, fontWeight: '800', letterSpacing: 0.4 },
});
