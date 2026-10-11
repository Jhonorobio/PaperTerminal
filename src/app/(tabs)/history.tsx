import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, router } from 'expo-router';

import { Icon } from '@/components/icons';
import { TokenAvatar } from '@/components/token-avatar';
import { Btn, Card, DetailRow, Empty, SegTabs, Skeleton } from '@/components/ui';
import { Palette, Radius, toneTint } from '@/constants/paper';
import {
  dayLabel,
  formatCompactQty,
  formatCompactUsd,
  formatPrice,
  formatUsd,
  pnlClass,
  timeOf,
  tone,
} from '@/lib/format';
import { api } from '@/lib/api';
import { alertDeepLink, fetchHistory, type AlertHistoryEntry } from '@/lib/notifications';
import type { Trade } from '@/lib/types';
import { useApp } from '@/state/app';

type SideFilter = '' | 'BUY' | 'SELL';
/** Trade fills and the alert feed (FOMO/Photon) now share one History page. */
type HistoryMode = 'trades' | 'alerts';

/** Server alert categories → labels, same taxonomy as the floating panel. */
const ALERT_LABELS: Record<string, string> = {
  fomo_graduated: 'FOMO Grad.',
  fomo_trending: 'FOMO Trend.',
  photon_new: 'Photon New',
  photon_graduated: 'Photon Grad.',
};

const toneColor = (v: number | null | undefined) =>
  pnlClass(v) === 'up' ? Palette.green : pnlClass(v) === 'down' ? Palette.red : Palette.textPrimary;

export default function HistoryScreen() {
  const { ready, user, banner, settings } = useApp();
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [side, setSide] = useState<SideFilter>('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  // Alerts are keyed by device (X-Device-Id), so they load with or without an account.
  const [mode, setMode] = useState<HistoryMode>('trades');
  const [alerts, setAlerts] = useState<AlertHistoryEntry[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (mode !== 'trades' || !user) return;
      void api
        .trades()
        .then((r) => setTrades(r.trades))
        .catch(() => setTrades((t) => t ?? []));
    }, [user, mode]),
  );

  useFocusEffect(
    useCallback(() => {
      if (mode !== 'alerts') return;
      void fetchHistory(settings.serverBase, 100)
        .then(setAlerts)
        .catch(() => setAlerts((a) => a ?? []));
    }, [mode, settings.serverBase]),
  );

  const visible = useMemo(() => {
    if (!trades) return null;
    const q = query.trim().toUpperCase();
    return trades.filter((t) => (side ? t.side === side : true) && (q ? (t.symbol ?? '').toUpperCase().includes(q) : true));
  }, [trades, side, query]);

  if (!ready) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <View style={styles.body}>
          <Skeleton height={90} />
          <Skeleton height={240} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>History</Text>
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push('/settings')} hitSlop={10} style={styles.gear}>
          <Icon name="gear" size={18} color={Palette.textSecondary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {banner ? <Text style={styles.banner}>{banner.text}</Text> : null}

        <View style={styles.filters}>
          <SegTabs
            value={mode}
            onChange={setMode}
            options={[
              { value: 'trades' as HistoryMode, label: 'Trades' },
              { value: 'alerts' as HistoryMode, label: 'Alertas' },
            ]}
          />
        </View>

        {mode === 'trades' ? (
        !user ? (
          <Card style={{ padding: 16, gap: 10 }}>
            <Empty title="Sign in to see your history" body="Every simulated fill lands here, newest first." />
            <Btn label="Go to Trade" variant="setup" onPress={() => router.push('/trade')} />
          </Card>
        ) : (
          <>
            <View style={styles.filters}>
              <SegTabs
                value={side}
                onChange={setSide}
                options={[
                  { value: '' as SideFilter, label: 'All' },
                  { value: 'BUY' as SideFilter, label: 'Buys' },
                  { value: 'SELL' as SideFilter, label: 'Sells' },
                ]}
              />
            </View>

            <View style={styles.search}>
              <Icon name="search" size={16} color={Palette.textTertiary} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search a ticker…"
                placeholderTextColor={Palette.textTertiary}
                autoCapitalize="characters"
                autoCorrect={false}
                style={styles.searchInput}
                accessibilityLabel="Search by ticker"
              />
            </View>

            {visible === null ? (
              <View style={{ gap: 6 }}>
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} height={56} />
                ))}
              </View>
            ) : !visible.length ? (
              <Card style={{ padding: 16 }}>
                <Empty
                  title={side || query ? 'No trades match' : 'No paper trades yet'}
                  body={side || query ? 'Try a different ticker or filter.' : 'Your buys and sells show up here, newest first.'}
                />
              </Card>
            ) : (
              <View style={{ gap: 6 }}>
                {visible.map((t, i) => {
                  const day = dayLabel(t.timestamp);
                  const previousDay = i > 0 ? dayLabel(visible[i - 1].timestamp) : null;
                  const isBuy = t.side === 'BUY';
                  const open = expanded === t.id;
                  const rowTone = isBuy ? '' : tone(t.realizedPnl);
                  return (
                    <View key={t.id}>
                      {day !== previousDay ? <Text style={styles.dayHeader}>{day}</Text> : null}
                      <View style={[styles.row, { backgroundColor: toneTint(rowTone as 'profit' | 'loss' | '') }]}>
                        <Pressable onPress={() => setExpanded(open ? null : t.id)} style={styles.rowMain} accessibilityRole="button">
                          <TokenAvatar symbol={t.symbol} chainId={t.chainId} address={t.address} size={34} />
                          <View style={styles.rowLead}>
                            <Text style={styles.rowName}>{t.symbol ?? '?'}</Text>
                            <Text style={styles.rowSub}>
                              <Text style={[styles.sideVerb, { color: isBuy ? Palette.green : Palette.red }]}>
                                {isBuy ? 'Bought' : 'Sold'}
                              </Text>{' '}
                              {formatCompactQty(t.quantity)} at {formatPrice(t.executionPrice)}
                            </Text>
                          </View>
                          <View style={styles.rowValue}>
                            <Text style={styles.rowMainValue}>{formatUsd(t.total)}</Text>
                            <Text style={[styles.rowSubValue, { color: t.realizedPnl === null ? Palette.textTertiary : toneColor(t.realizedPnl) }]}>
                              {t.realizedPnl === null ? timeOf(t.timestamp) : formatUsd(t.realizedPnl, { sign: true })}
                            </Text>
                          </View>
                          <Icon
                            name="chevron"
                            size={13}
                            color={Palette.textTertiary}
                            style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
                          />
                        </Pressable>

                        {open ? (
                          <View style={styles.detail}>
                            <DetailRow label="Time" value={new Date(t.timestamp).toLocaleString()} />
                            <DetailRow label="Requested" value={formatUsd(t.requestedValue)} />
                            <DetailRow label="Market price" value={formatPrice(t.marketPrice)} />
                            <DetailRow label="Fill price" value={formatPrice(t.executionPrice)} />
                            <DetailRow label="Simulated fee" value={formatUsd(t.fee)} />
                            <DetailRow label="Simulated slippage" value={formatUsd(t.slippage)} />
                            <DetailRow label="Cash after" value={formatUsd(t.cashAfter)} />
                            <DetailRow label="Liquidity" value={formatCompactUsd(t.liquidityUsd)} />
                            <DetailRow label="Market cap" value={formatCompactUsd(t.marketCapUsd)} />
                            <DetailRow label="Position" value={t.status === 'closed' ? 'Closed' : 'Still open'} />
                          </View>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )
) : alerts === null ? (
          <View style={{ gap: 6 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={56} />)}</View>
        ) : !alerts.length ? (
          <Card style={{ padding: 16 }}>
            <Empty title="Sin notificaciones todavía" body="Se disparan con los filtros de FOMO y Photon — lo que ves en esas listas es lo que te avisa." />
          </Card>
        ) : (
          <View style={{ gap: 6 }}>
            {alerts.map((entry, i) => {
              const day = dayLabel(entry.notified_at);
              const previousDay = i > 0 ? dayLabel(alerts[i - 1].notified_at) : null;
              return (
                <View key={entry.id}>
                  {day !== previousDay ? <Text style={styles.dayHeader}>{day}</Text> : null}
                  <Pressable
                    onPress={() => router.push(alertDeepLink(entry) as never)}
                    style={({ pressed }) => [styles.row, styles.alertRow, pressed && { backgroundColor: Palette.bgTertiarySolid }]}>
                    <TokenAvatar
                      symbol={entry.symbol}
                      chainId={entry.chain === 'sol' ? 'solana' : entry.chain}
                      address={entry.address}
                      size={34}
                    />
                    <View style={styles.rowLead}>
                      <Text style={styles.rowName}>{entry.symbol ?? 'Token'}</Text>
                      <Text style={styles.rowSub}>
                        {ALERT_LABELS[entry.category] ?? entry.category}
                        {entry.mcap != null ? ` · ${formatCompactUsd(entry.mcap)} MC` : ''}
                      </Text>
                    </View>
                    {/* Exact time, not "10m ago" — the alert feed is read as a timeline.
                        rowSubValue has no color (trades pass the PnL tone inline), so set one here. */}
                    <Text style={[styles.rowSubValue, { color: Palette.textSecondary }]}>{timeOf(entry.notified_at)}</Text>
                    <Icon name="chevron" size={13} color={Palette.textTertiary} style={{ transform: [{ rotate: '-90deg' }] }} />
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Palette.bgPrimary },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6 },
  title: { fontSize: 22, fontWeight: '800', color: Palette.textPrimary },
  gear: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: Palette.bgSecondary },

  body: { padding: 14, gap: 10, paddingBottom: 32 },
  banner: { fontSize: 13, color: Palette.textSecondary },

  filters: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Palette.lineStrong,
    backgroundColor: Palette.bgSecondary,
    paddingHorizontal: 12,
  },
  searchInput: { flex: 1, color: Palette.textPrimary, fontSize: 14, paddingVertical: 9 },

  dayHeader: { fontSize: 12, fontWeight: '800', color: Palette.textTertiary, textTransform: 'uppercase', letterSpacing: 1, marginTop: 6 },

  row: { borderRadius: Radius.md, borderWidth: 1, borderColor: Palette.line, overflow: 'hidden' },
  // Alert rows paint their own background + padding (the trade rows get those from the
  // tone-tinted wrapper + rowMain), matching the cards the history had in Notificaciones.
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, backgroundColor: Palette.bgPrimary },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 },
  rowLead: { flex: 1, gap: 2, minWidth: 0 },
  rowName: { fontSize: 14, fontWeight: '800', color: Palette.textPrimary },
  rowSub: { fontSize: 12, color: Palette.textSecondary, fontVariant: ['tabular-nums'] },
  sideVerb: { fontWeight: '800' },
  rowValue: { alignItems: 'flex-end', gap: 1 },
  rowMainValue: { fontSize: 14, fontWeight: '800', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  rowSubValue: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },

  detail: { paddingHorizontal: 10, paddingBottom: 10, gap: 5, borderTopWidth: 1, borderTopColor: Palette.line, paddingTop: 8 },
});
