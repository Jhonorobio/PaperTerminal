import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { Icon } from '@/components/icons';
import { Banner, Card } from '@/components/ui';
import { TokenPicker } from '@/components/token-picker';
import { TradePanel } from '@/components/trade-panel';
import { Palette, Radius } from '@/constants/paper';
import { formatUsd, pnlClass } from '@/lib/format';
import type { Asset } from '@/lib/types';
import { useApp } from '@/state/app';

/** Cash / equity / P&L strip — the overlay's `head-cards`, which the side panel never showed. */
function AccountStrip() {
  const { user, account, portfolio, needsSetup } = useApp();
  if (!user || needsSetup) return null;
  const perf = portfolio?.performance;
  const cash = perf?.cash ?? account?.cashBalance;
  const pnl = perf?.totalPnl;
  const tone = pnlClass(pnl);

  return (
    <View style={styles.strip}>
      <View style={styles.stripCard}>
        <Text style={styles.stripValue}>{formatUsd(cash)}</Text>
        <Text style={styles.stripLabel}>cash</Text>
      </View>
      <View style={styles.stripCard}>
        <Text style={styles.stripValue}>{formatUsd(perf?.totalEquity ?? cash)}</Text>
        <Text style={styles.stripLabel}>equity</Text>
      </View>
      <View style={styles.stripCard}>
        <Text style={[styles.stripValue, { color: tone === 'up' ? Palette.green : tone === 'down' ? Palette.red : Palette.textPrimary }]}>
          {formatUsd(pnl, { sign: true })}
        </Text>
        <Text style={styles.stripLabel}>
          {perf ? `total · ${perf.openPositionCount || 0} open` : 'total'}
        </Text>
      </View>
    </View>
  );
}

export default function TradeScreen() {
  const { ready, recents, banner, flash } = useApp();
  // No token to read from a tab, so the most recent one is the default until the user picks
  // another — held as an override rather than copied into state by an effect.
  const [assetOverride, setAssetOverride] = useState<Asset | null | undefined>(undefined);
  const asset = assetOverride !== undefined ? assetOverride : (recents[0] ?? null);

  if (!ready) return <View style={styles.screen} />;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.pill}>
          <Icon name="paper" size={12} color={Palette.paper} />
          <Text style={styles.pillText}>PAPER MODE</Text>
        </View>
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push('/settings')} hitSlop={10} style={styles.gear}>
          <Icon name="gear" size={18} color={Palette.textSecondary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <AccountStrip />

        {banner ? <Banner kind={banner.kind}>{banner.text}</Banner> : null}

        <TokenPicker value={asset} onChange={setAssetOverride} />

        <TradePanel asset={asset} />

        {!asset ? (
          <Card style={{ padding: 14 }}>
            <Text style={styles.emptyTitle}>Pick a token to practice on</Text>
            <Text style={styles.emptyBody}>
              Paste a fomo.family or DexScreener link, or just drop in the address — a bare one is read
              as Solana, since the paper server has no search.
            </Text>
            <Pressable onPress={() => flash('ok', 'Example: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')} style={styles.example}>
              <Text style={styles.exampleText}>DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263</Text>
            </Pressable>
          </Card>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Palette.bgPrimary },

  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: Radius.pill,
    backgroundColor: Palette.paperT,
    borderWidth: 1,
    borderColor: Palette.paperLine,
  },
  pillText: { fontSize: 11, fontWeight: '800', color: Palette.paper, letterSpacing: 0.6 },
  gear: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: Palette.bgSecondary },

  body: { padding: 14, gap: 10, paddingBottom: 32 },

  strip: { flexDirection: 'row', gap: 8 },
  stripCard: {
    flex: 1,
    backgroundColor: Palette.bgSecondary,
    borderWidth: 1,
    borderColor: Palette.line,
    borderRadius: Radius.md,
    paddingVertical: 9,
    paddingHorizontal: 10,
    gap: 1,
  },
  stripValue: { fontSize: 15, fontWeight: '800', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  stripLabel: { fontSize: 11, color: Palette.textTertiary },

  emptyTitle: { fontSize: 15, fontWeight: '800', color: Palette.textPrimary },
  emptyBody: { fontSize: 13, color: Palette.textSecondary, lineHeight: 19 },
  example: {
    marginTop: 6,
    alignSelf: 'flex-start',
    backgroundColor: Palette.bgSecondary,
    borderWidth: 1,
    borderColor: Palette.line,
    borderRadius: Radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  exampleText: { fontSize: 12, color: Palette.paper, fontVariant: ['tabular-nums'] },
});
