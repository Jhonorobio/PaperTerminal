import { useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, router } from 'expo-router';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Svg, { Circle } from 'react-native-svg';

import { Icon, type IconName } from '@/components/icons';
import { Btn, Card, Empty, Skeleton, Stat, StatGrid } from '@/components/ui';
import { Palette, Radius } from '@/constants/paper';
import { STYLE_SAMPLE } from '@/lib/config';
import { formatDuration, formatPct, formatUsd, pnlClass } from '@/lib/format';
import { api } from '@/lib/api';
import { useApp } from '@/state/app';

const toneColor = (v: number | null | undefined) =>
  pnlClass(v) === 'up' ? Palette.green : pnlClass(v) === 'down' ? Palette.red : Palette.textPrimary;

const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '-' : v.toFixed(d));

function Record({ icon, value, label, color }: { icon: IconName; value: string; label: string; color?: string }) {
  return (
    <View style={styles.record}>
      <View style={styles.recordIcon}>
        <Icon name={icon} size={16} color={Palette.paper} />
      </View>
      <Text style={[styles.recordValue, color && { color }]}>{value}</Text>
      <Text style={styles.recordLabel}>{label}</Text>
    </View>
  );
}

export default function StyleScreen() {
  const { ready, user, portfolio, loadPortfolio, flash, busy, setBusy } = useApp();

  useFocusEffect(
    useCallback(() => {
      void loadPortfolio();
    }, [loadPortfolio]),
  );

  const doExport = async (format: 'json' | 'csv') => {
    setBusy(true);
    try {
      const data = await api.export(format);
      const file = new File(Paths.cache, data.filename);
      if (file.exists) file.delete();
      file.create();
      file.write(data.text);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: data.contentType, dialogTitle: data.filename });
      } else {
        flash('err', 'Sharing is not available on this device.');
      }
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <View style={styles.body}>
          <Skeleton height={108} />
          <Skeleton height={80} />
          <Skeleton height={200} />
        </View>
      </SafeAreaView>
    );
  }

  if (!user || !portfolio) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <Header />
        <Card style={{ margin: 14, padding: 16, gap: 10 }}>
          <Empty
            title="Your trading style unlocks here"
            body={user ? 'Close a few trades and the app reads how you hold and size positions.' : 'Sign in and trade to get feedback on your style.'}
          />
          <Btn label="Go to Trade" variant="setup" onPress={() => router.push('/trade')} />
        </Card>
      </SafeAreaView>
    );
  }

  const s = portfolio.tradingStyle;
  const perf = portfolio.performance;
  const n = s?.sampleSize ?? 0;
  const unlocked = n >= STYLE_SAMPLE;
  const remaining = STYLE_SAMPLE - n;
  const progress = Math.min(n / STYLE_SAMPLE, 1);
  const circumference = 2 * Math.PI * 32;
  const best = perf.bestTrade;
  const offsetHours = new Date().getTimezoneOffset() / 60;
  const utc = s?.activityByHourUtc ?? new Array(24).fill(0);
  const localHours = utc.map((_, h) => utc[(((h + Math.round(offsetHours)) % 24) + 24) % 24]);
  const maxHour = Math.max(1, ...localHours);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <Header />
      <ScrollView contentContainerStyle={styles.body}>
        <Card style={styles.hero}>
          <View style={styles.ring}>
            <Svg width={76} height={76} viewBox="0 0 76 76">
              <Circle cx={38} cy={38} r={32} stroke={Palette.bgTertiary} strokeWidth={7} fill="none" />
              <Circle
                cx={38}
                cy={38}
                r={32}
                stroke={Palette.paper}
                strokeWidth={7}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={circumference.toFixed(2)}
                strokeDashoffset={(circumference * (1 - progress)).toFixed(2)}
                transform="rotate(-90 38 38)"
              />
            </Svg>
            <View style={styles.ringLabel}>
              {unlocked ? <Icon name="check" size={22} color={Palette.paper} /> : <Text style={styles.ringText}>{`${n}/${STYLE_SAMPLE}`}</Text>}
            </View>
          </View>
          <View style={styles.heroText}>
            <Text style={styles.kicker}>Your trading style</Text>
            {unlocked ? (
              <>
                <Text style={styles.heroTitle}>{s?.style ?? 'Trader'}</Text>
                <Text style={styles.heroBody}>
                  {s?.styleDescription ?? ''} Based on {n} closed trades.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.heroTitle}>{`Close ${remaining} more trade${remaining === 1 ? '' : 's'}`}</Text>
                <Text style={styles.heroBody}>
                  After {STYLE_SAMPLE} closed trades you get a read on how you hold and size positions.
                </Text>
              </>
            )}
          </View>
        </Card>

        <View style={styles.records}>
          <Record
            icon="trophy"
            value={best ? formatUsd(best.realizedPnl, { sign: true }) : '-'}
            label={best ? `Best trade, ${best.symbol ?? ''}` : 'Best trade'}
            color={best ? toneColor(best.realizedPnl) : undefined}
          />
          <Record
            icon="trendUp"
            value={s?.personalBests?.bestReturnPct === null || s?.personalBests?.bestReturnPct === undefined ? '-' : formatPct(s.personalBests.bestReturnPct)}
            label="Best return"
          />
          <Record icon="target" value={String(s?.longestWinningRun ?? 0)} label="Wins in a row" />
        </View>

        <Text style={styles.sectionH}>How you trade</Text>
        <Card style={{ padding: 4 }}>
          <StatGrid>
            <Stat label="Median hold" value={formatDuration(s?.medianHoldMs)} />
            <Stat label="Win rate" value={s?.winRatePct === null || s?.winRatePct === undefined ? '-' : formatPct(s.winRatePct, { sign: false })} />
            <Stat
              label="Profit factor"
              value={num(s?.profitFactor)}
              hint="Gross profit over gross loss"
              color={s?.profitFactor == null ? undefined : s.profitFactor >= 1 ? Palette.green : Palette.red}
            />
            <Stat label="Expectancy" value={formatUsd(s?.expectancyUsd, { sign: true })} hint="Average result per trade" color={toneColor(s?.expectancyUsd)} />
            <Stat label="Average win" value={formatUsd(s?.averageWinUsd, { sign: true })} color={Palette.green} />
            <Stat label="Average loss" value={formatUsd(s?.averageLossUsd, { sign: true })} color={Palette.red} />
            <Stat
              label="Buy size"
              value={formatUsd(s?.averageBuySizeUsd)}
              hint={s?.averageBuyPctOfCash == null ? undefined : `${formatPct(s.averageBuyPctOfCash, { sign: false })} of cash`}
            />
            <Stat
              label="Max drawdown"
              value={s?.maxRealizedDrawdownPct ? formatPct(-s.maxRealizedDrawdownPct) : '0.00%'}
              hint="On closed trades"
              color={s?.maxRealizedDrawdownPct ? Palette.red : undefined}
            />
          </StatGrid>
        </Card>

        <Text style={styles.sectionH}>Coaching</Text>
        {s?.insights?.length ? (
          <Card style={{ padding: 12, gap: 10 }}>
            {s.insights.map((insight, i) => (
              <View key={i} style={styles.note}>
                <Icon name="lightning" size={14} color={Palette.paper} />
                <Text style={styles.noteText}>{insight}</Text>
              </View>
            ))}
          </Card>
        ) : (
          <Card style={{ padding: 12 }}>
            <Text style={styles.muted}>No notes yet — they appear as your sample grows.</Text>
          </Card>
        )}

        <Text style={styles.sectionH}>When you trade (local time)</Text>
        <Card style={{ padding: 12, gap: 6 }}>
          <View style={styles.hours}>
            {localHours.map((count, h) => (
              <View
                key={h}
                style={[
                  styles.hour,
                  {
                    height: count ? Math.max(8, (count / maxHour) * 72) : 4,
                    backgroundColor: count ? Palette.paper : Palette.bgTertiary,
                  },
                ]}
              />
            ))}
          </View>
          <View style={styles.hoursAxis}>
            <Text style={styles.axisText}>00</Text>
            <Text style={styles.axisText}>06</Text>
            <Text style={styles.axisText}>12</Text>
            <Text style={styles.axisText}>18</Text>
            <Text style={styles.axisText}>23</Text>
          </View>
        </Card>

        <Text style={styles.sectionH}>Download history</Text>
        <Card style={{ padding: 12, gap: 8 }}>
          <Text style={styles.muted}>
            JSON has every fill, closed trades, open positions and these style metrics. CSV has one row per fill.
          </Text>
          <View style={styles.exportRow}>
            <Btn label="JSON" variant="sm" icon="download" busy={busy} onPress={() => void doExport('json')} />
            <Btn label="CSV" variant="sm" icon="download" busy={busy} onPress={() => void doExport('csv')} />
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function Header() {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>Trading style</Text>
      <View style={{ flex: 1 }} />
      <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push('/settings')} hitSlop={10} style={styles.gear}>
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

  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 },
  ring: { width: 76, height: 76, alignItems: 'center', justifyContent: 'center' },
  ringLabel: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  ringText: { fontSize: 14, fontWeight: '800', color: Palette.paper, fontVariant: ['tabular-nums'] },
  heroText: { flex: 1, gap: 3 },
  kicker: { fontSize: 11, fontWeight: '800', color: Palette.paper, textTransform: 'uppercase', letterSpacing: 1 },
  heroTitle: { fontSize: 18, fontWeight: '800', color: Palette.textPrimary },
  heroBody: { fontSize: 13, color: Palette.textSecondary, lineHeight: 18 },

  records: { flexDirection: 'row', gap: 8 },
  record: {
    flex: 1,
    backgroundColor: Palette.bgSecondary,
    borderWidth: 1,
    borderColor: Palette.line,
    borderRadius: Radius.md,
    padding: 10,
    gap: 2,
    alignItems: 'flex-start',
  },
  recordIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: Palette.paperT, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  recordValue: { fontSize: 15, fontWeight: '800', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  recordLabel: { fontSize: 11, color: Palette.textTertiary },

  sectionH: { fontSize: 16, fontWeight: '800', color: Palette.textPrimary, marginTop: 6 },

  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  noteText: { flex: 1, fontSize: 13, color: Palette.textSecondary, lineHeight: 19 },
  muted: { fontSize: 13, color: Palette.textSecondary, lineHeight: 19 },

  hours: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 76 },
  hour: { flex: 1, borderRadius: 3, minWidth: 4 },
  hoursAxis: { flexDirection: 'row', justifyContent: 'space-between' },
  axisText: { fontSize: 10, color: Palette.textTertiary, fontVariant: ['tabular-nums'] },

  exportRow: { flexDirection: 'row', gap: 8 },
});
