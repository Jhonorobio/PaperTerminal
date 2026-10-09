import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, router } from 'expo-router';

import { Icon } from '@/components/icons';
import { PositionsList } from '@/components/positions-list';
import { Banner, Btn, Card, Empty, SegTabs, Skeleton, Stat, StatGrid } from '@/components/ui';
import { Palette, Radius } from '@/constants/paper';
import { DUST_USD } from '@/lib/config';
import { formatPct, formatUsd, pnlClass } from '@/lib/format';
import { api } from '@/lib/api';
import type { ClosedTrade } from '@/lib/types';
import { useApp } from '@/state/app';

const toneColor = (v: number | null | undefined) =>
  pnlClass(v) === 'up' ? Palette.green : pnlClass(v) === 'down' ? Palette.red : Palette.textPrimary;

export default function PortfolioScreen() {
  const { ready, user, portfolio, settings, updateSettings, loadPortfolio, banner, busy } = useApp();
  const [posTab, setPosTab] = useState<'open' | 'closed'>('open');
  const [closed, setClosed] = useState<ClosedTrade[] | null>(null);

  // The portfolio is polled by the provider; the closed list is only needed on that tab.
  useFocusEffect(
    useCallback(() => {
      void loadPortfolio();
      if (user && posTab === 'closed') {
        void api
          .closedTrades()
          .then((r) => setClosed(r.closedTrades))
          .catch(() => undefined);
      }
    }, [loadPortfolio, user, posTab]),
  );

  if (!ready) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <View style={styles.body}>
          <Skeleton height={96} />
          <Skeleton height={120} />
          <Skeleton height={220} />
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <Header />
        <Card style={{ margin: 14, padding: 16, gap: 10 }}>
          <Empty
            title="Sign in to see your portfolio"
            body="Prices work without an account, but positions and history are yours after you sign in."
          />
          <Btn label="Continue on the Trade tab" variant="setup" onPress={() => router.push('/trade')} />
        </Card>
      </SafeAreaView>
    );
  }

  if (!portfolio) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <Header />
        <ScrollView contentContainerStyle={styles.body}>
          {banner ? <Banner kind={banner.kind}>{banner.text}</Banner> : null}
          <Skeleton height={96} />
          <Skeleton height={120} />
          <Skeleton height={220} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  const perf = portfolio.performance;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <Header />
      <ScrollView contentContainerStyle={styles.body}>
        {banner ? <Banner kind={banner.kind}>{banner.text}</Banner> : null}

        <Card style={styles.equity} tone="paper">
          <Text style={styles.equityLabel}>Total equity</Text>
          <Text style={styles.equityValue}>{formatUsd(perf.totalEquity)}</Text>
          <View style={styles.equityLine}>
            <Icon name={perf.totalPnl >= 0 ? 'trendUp' : 'trendDown'} size={14} color={toneColor(perf.totalPnl)} />
            <Text style={[styles.equityPnl, { color: toneColor(perf.totalPnl) }]}>
              {formatUsd(perf.totalPnl, { sign: true })} ({formatPct(perf.totalPnlPct)})
            </Text>
          </View>
          <Text style={styles.equitySince}>since starting with {formatUsd(perf.startingBalance, { decimals: 0 })}</Text>
        </Card>

        <Card style={{ padding: 4 }}>
          <StatGrid>
            <Stat label="Cash" value={formatUsd(perf.cash)} />
            <Stat label="Invested" value={formatUsd(perf.invested)} />
            <Stat label="Today" value={formatUsd(perf.todayPnl, { sign: true })} color={toneColor(perf.todayPnl)} />
            <Stat label="Unrealized" value={formatUsd(perf.unrealizedPnl, { sign: true })} color={toneColor(perf.unrealizedPnl)} />
            <Stat
              label="Win rate"
              value={perf.winRate === null ? '-' : formatPct(perf.winRate, { sign: false })}
              hint={`${perf.wins ?? 0} won, ${perf.losses ?? 0} lost`}
            />
            <Stat
              label="Trades"
              value={String(perf.tradeCount ?? 0)}
              hint={`${perf.buyCount ?? 0} buys, ${perf.sellCount ?? 0} sells`}
            />
          </StatGrid>
        </Card>

        <View style={styles.posHead}>
          <Text style={styles.sectionTitle}>Your positions</Text>
          <View style={styles.controls}>
            <SegTabs
              value={settings.priceDisplay}
              onChange={(v) => void updateSettings({ priceDisplay: v })}
              options={[
                { value: 'price', label: '$' },
                { value: 'mcap', label: 'MC' },
              ]}
            />
            <SegTabs
              value={posTab}
              onChange={(v) => {
                setPosTab(v);
                if (v === 'closed' && closed === null) {
                  void api
                    .closedTrades()
                    .then((r) => setClosed(r.closedTrades))
                    .catch(() => setClosed([]));
                }
              }}
              options={[
                { value: 'open', label: `Open${portfolio.positions.length ? ' •' : ''}` },
                { value: 'closed', label: 'Closed' },
              ]}
            />
          </View>
        </View>

        <PositionsList
          tab={posTab}
          positions={portfolio.positions}
          closed={closed}
          hideDust={settings.hideDust}
          priceDisplay={settings.priceDisplay}
          pending={busy}
          onClosePosition={() => router.push('/trade')}
        />

        {(() => {
          if (posTab !== 'open') return null;
          const dustCount = portfolio.positions.filter((p) => (p.marketValue ?? p.costBasis) < DUST_USD).length;
          if (!dustCount) return null;
          return (
            <Pressable
              onPress={() => void updateSettings({ hideDust: !settings.hideDust })}
              style={styles.dust}>
              <Text style={styles.dustText}>
                {settings.hideDust ? `Show dust (${dustCount})` : 'Hide dust'}
              </Text>
            </Pressable>
          );
        })()}
      </ScrollView>
    </SafeAreaView>
  );
}

function Header() {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>Portfolio</Text>
      <View style={{ flex: 1 }} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => router.push('/settings')}
        hitSlop={10}
        style={styles.gear}>
        <Icon name="gear" size={18} color={Palette.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Palette.bgPrimary },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6 },
  title: { fontSize: 22, fontWeight: '800', color: Palette.textPrimary },
  gear: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: Palette.bgSecondary },

  body: { padding: 14, gap: 10, paddingBottom: 32 },

  equity: { alignItems: 'flex-start', gap: 2, padding: 14 },
  equityLabel: { fontSize: 12, fontWeight: '700', color: Palette.textSecondary, textTransform: 'uppercase', letterSpacing: 1 },
  equityValue: { fontSize: 32, fontWeight: '800', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  equityLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  equityPnl: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  equitySince: { fontSize: 12, color: Palette.textTertiary },

  posHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: Palette.textPrimary },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  dust: {
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.pill,
    backgroundColor: Palette.bgSecondary,
    borderWidth: 1,
    borderColor: Palette.line,
  },
  dustText: { fontSize: 12, fontWeight: '700', color: Palette.textSecondary },
});
