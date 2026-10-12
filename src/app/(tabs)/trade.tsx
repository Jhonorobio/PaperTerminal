import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';

import { Icon } from '@/components/icons';
import { Banner, Card } from '@/components/ui';
import { TokenPicker } from '@/components/token-picker';
import { TradePanel } from '@/components/trade-panel';
import { Palette, Radius } from '@/constants/paper';
import { formatUsd, pnlClass } from '@/lib/format';
import { addRecentAsset } from '@/lib/storage';
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
  // A link — a tapped alert, a token tapped in FOMO/Photon, or a clipboard copy —
  // preselects its token. Tabs reuse the mounted screen, so a NEW address arrives as
  // a params change — not a remount — and has to win over the previous selection. The
  // linked asset wins until the user picks one manually (that pick "consumes" the
  // link), and any new link wins back over that manual choice — pure state, no refs
  // in render and no setState in effects. Without the param, a stale manual pick
  // (assetOverride) kept showing instead of the token that was tapped.
  const [consumedLink, setConsumedLink] = useState<string | null>(null);
  const params = useLocalSearchParams<{ address?: string; symbol?: string; chain?: string }>();
  const linkAddress = typeof params.address === 'string' ? params.address : null;
  const linkChain = (typeof params.chain === 'string' ? params.chain : null) ?? 'solana';
  const linkKey = linkAddress ? `${linkChain}:${linkAddress.toLowerCase()}` : null;
  const linkedAsset: Asset | null =
    linkAddress && linkKey !== consumedLink
      ? { chain: linkChain, address: linkAddress, symbol: params.symbol ?? null, source: 'url' }
      : null;

  // No token to read from a tab, so the most recent one is the default until the user picks
  // another — held as an override rather than copied into state by an effect.
  const [assetOverride, setAssetOverride] = useState<Asset | null | undefined>(undefined);
  const pickAsset = (next: Asset | null) => {
    setConsumedLink(linkKey); // the user's choice settles whatever link is showing
    setAssetOverride(next);
  };

  // Keep the deep-linked token in the recents list — the picker and persistence treat it
  // like any other asset.
  useEffect(() => {
    if (!linkKey || !linkAddress) return;
    void addRecentAsset({ chain: linkChain, address: linkAddress, symbol: params.symbol ?? null, source: 'url' });
  }, [linkKey, linkAddress, linkChain, params.symbol]);

  const asset = linkedAsset ?? (assetOverride !== undefined ? assetOverride : recents[0]) ?? null;

  // GMGN's token page per chain: gmgn.ai/{chain}/token/{address}.
  const GMGN_CHAIN: Record<string, string> = { solana: 'sol', ethereum: 'eth', base: 'base', bsc: 'bsc', monad: 'monad' };
  const openGmgn = async () => {
    if (!asset) return;
    const chain = GMGN_CHAIN[asset.chain] ?? asset.chain;
    await WebBrowser.openBrowserAsync(`https://gmgn.ai/${chain}/token/${encodeURIComponent(asset.address)}`);
  };

  if (!ready) return <View style={styles.screen} />;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.pill}>
          <Icon name="paper" size={12} color={Palette.paper} />
          <Text style={styles.pillText}>PAPER MODE</Text>
        </View>
        <View style={{ flex: 1 }} />
        {asset ? (
          <Pressable accessibilityRole="link" accessibilityLabel="Ver el token en GMGN" onPress={() => void openGmgn()} hitSlop={10} style={styles.gmgn}>
            <Text style={styles.gmgnText}>GMGN</Text>
            <Icon name="external" size={13} color={Palette.paper} />
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push('/settings')} hitSlop={10} style={styles.gear}>
          <Icon name="gear" size={18} color={Palette.textSecondary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <AccountStrip />

        {banner ? <Banner kind={banner.kind}>{banner.text}</Banner> : null}

        <TokenPicker value={asset} onChange={pickAsset} />

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
  gmgn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: Radius.pill,
    backgroundColor: Palette.paperT,
    borderWidth: 1,
    borderColor: Palette.paperLine,
  },
  gmgnText: { fontSize: 11, fontWeight: '800', color: Palette.paper, letterSpacing: 0.6 },

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
