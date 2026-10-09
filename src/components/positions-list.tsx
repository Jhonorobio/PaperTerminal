// Port of positions.js's positionsListHtml: the "Your positions" rows, minus the DOM. Tapping a
// row expands the same details the extension showed in its hover card, and the token logo loads
// through TokenAvatar instead of a mutation observer swapping letter avatars for images.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/icons';
import { ChainTag, TokenAvatar } from '@/components/token-avatar';
import { Btn, DetailRow, Empty, Skeleton } from '@/components/ui';
import { Palette, Radius, toneTint } from '@/constants/paper';
import { DUST_USD } from '@/lib/config';
import {
  arrow,
  formatCompactQty,
  formatCompactUsd,
  formatDateTime,
  formatDuration,
  formatPct,
  formatUsd,
  pnlClass,
  timeAgo,
  tone,
} from '@/lib/format';
import type { ClosedTrade, Position } from '@/lib/types';

const levelFormatter = (priceDisplay: 'price' | 'mcap') => ({
  level: (price?: number | null, marketCap?: number | null) =>
    priceDisplay === 'mcap' && (marketCap ?? 0) > 0 ? `${formatCompactUsd(marketCap)} MC` : formatPriceSafe(price),
  label: (word: string) => (priceDisplay === 'mcap' ? `${word} MC` : `${word} price`),
});

// Kept local so the component doesn't depend on formatCompactUsd's rounding for tiny caps.
const formatPriceSafe = (price?: number | null) => (price == null ? '-' : formatUsd(price, { decimals: price < 1 ? 6 : 2 }));

/** Symbols that appear on more than one address, so rows say which chain they are. */
function duplicateSymbols(items: ({ symbol?: string } | null)[]) {
  const seen = new Map<string, number>();
  for (const i of items) {
    const s = i?.symbol;
    if (s) seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([s]) => s));
}

const PnlValue = ({ value, pct }: { value: number; pct?: number | null }) => {
  const cls = pnlClass(value);
  const color = cls === 'up' ? Palette.green : cls === 'down' ? Palette.red : Palette.textPrimary;
  return (
    <View style={styles.rowValue}>
      <Text style={[styles.rowMain, { color }]}>{formatUsd(value, { sign: true })}</Text>
      <Text style={[styles.rowSub, { color }]}>
        {arrow(value)} {formatPct(Math.abs(pct ?? 0), { sign: false })}
      </Text>
    </View>
  );
};

interface Props {
  tab: 'open' | 'closed';
  positions: Position[] | null;
  closed: ClosedTrade[] | null;
  hideDust: boolean;
  priceDisplay: 'price' | 'mcap';
  pending?: boolean;
  currentAssetId?: string;
  onClosePosition?: (a: { chain: string; address: string }) => void;
  onShare?: (text: string) => void;
}

export function PositionsList({ tab, positions, closed, hideDust, priceDisplay, pending, currentAssetId, onClosePosition, onShare }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const level = levelFormatter(priceDisplay);

  if (tab === 'open') {
    if (positions === null) {
      return (
        <View style={styles.list}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={64} />
          ))}
        </View>
      );
    }
    if (!positions.length) {
      return <Empty title="No open positions" body="Buy a token and it shows up here." />;
    }
    const dust = positions.filter((p) => (p.marketValue ?? p.costBasis) < DUST_USD);
    const visible = hideDust ? positions.filter((p) => !dust.includes(p)) : positions;
    if (!visible.length) {
      return <Empty title={`Only small positions under ${formatUsd(DUST_USD, { decimals: 0 })}.`} />;
    }
    const dup = duplicateSymbols(positions);

    return (
      <View style={styles.list}>
        {visible.map((p) => {
          const id = `open:${p.assetId}`;
          const isOpen = expanded === id;
          const value = p.marketValue ?? p.costBasis;
          const isCurrent = p.assetId === currentAssetId;
          return (
            <View key={id} style={[styles.row, { backgroundColor: toneTint(tone(p.unrealizedPnl)) }]}>
              <Pressable onPress={() => setExpanded(isOpen ? null : id)} style={styles.rowMainArea} accessibilityRole="button">
                <TokenAvatar symbol={p.symbol} chainId={p.chainId} address={p.address} size={34} />
                <View style={styles.rowLead}>
                  <View style={styles.nameLine}>
                    <Text style={styles.name}>{p.symbol ?? '?'}</Text>
                    {isCurrent ? <Text style={styles.here}>this token</Text> : null}
                  </View>
                  <View style={styles.subLine}>
                    {dup.has(p.symbol ?? '') ? <ChainTag chain={p.chainId} /> : null}
                    <Text style={styles.sub}>
                      {formatCompactQty(p.quantity)} {p.symbol ?? ''}
                    </Text>
                  </View>
                </View>
                <PnlValue value={p.unrealizedPnl} pct={p.unrealizedPnlPct} />
                <Icon name="chevron" size={13} color={Palette.textTertiary} style={{ transform: [{ rotate: isOpen ? '180deg' : '0deg' }] }} />
              </Pressable>

              {isOpen ? (
                <View style={styles.detail}>
                  <DetailRow label={priceDisplay === 'mcap' ? 'Avg entry MC' : 'Avg entry'} value={level.level(p.averageEntryPrice, p.entryMarketCapUsd)} />
                  <DetailRow label={level.label('Current')} value={level.level(p.currentPrice, p.marketCapUsd)} />
                  <DetailRow label="Holding" value={`${formatCompactQty(p.quantity)} ${p.symbol ?? ''}`} />
                  <DetailRow label="Cost" value={formatUsd(p.costBasis)} />
                  <DetailRow
                    label="Unrealized P&L"
                    value={`${formatUsd(p.unrealizedPnl, { sign: true })} (${formatPct(p.unrealizedPnlPct)})`}
                    color={pnlClass(p.unrealizedPnl) === 'up' ? Palette.green : Palette.red}
                  />
                  <DetailRow label="Value" value={formatUsd(value)} />
                  <DetailRow label="Opened" value={timeAgo(p.openedAt)} />
                  <View style={styles.actions}>
                    <Btn label="Share P&L" variant="share" icon="share" onPress={() => onShare?.(shareOpen(p, level))} />
                    <Btn
                      label="Sell all"
                      variant="danger"
                      busy={pending}
                      onPress={() => onClosePosition?.({ chain: p.chainId ?? '', address: p.address ?? '' })}
                    />
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    );
  }

  if (closed === null) {
    return (
      <View style={styles.list}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={64} />
        ))}
      </View>
    );
  }
  if (!closed.length) return <Empty title="No closed trades yet" body="Sell a whole position and its result lands here." />;
  const dup = duplicateSymbols(closed);

  return (
    <View style={styles.list}>
      {closed.map((t) => {
        const id = `closed:${t.id}`;
        const isOpen = expanded === id;
        return (
          <View key={id} style={[styles.row, { backgroundColor: toneTint(tone(t.realizedPnl)) }]}>
            <Pressable onPress={() => setExpanded(isOpen ? null : id)} style={styles.rowMainArea} accessibilityRole="button">
              <TokenAvatar symbol={t.symbol} chainId={t.chainId} address={t.address} size={34} />
              <View style={styles.rowLead}>
                <View style={styles.nameLine}>
                  <Text style={styles.name}>{t.symbol ?? '?'}</Text>
                </View>
                <View style={styles.subLine}>
                  {dup.has(t.symbol ?? '') ? <ChainTag chain={t.chainId} /> : null}
                  <Text style={styles.sub}>
                    Held {formatDuration(t.holdMs)}, closed {timeAgo(t.exitTime)}
                  </Text>
                </View>
              </View>
              <PnlValue value={t.realizedPnl} pct={t.returnPct} />
              <Icon name="chevron" size={13} color={Palette.textTertiary} style={{ transform: [{ rotate: isOpen ? '180deg' : '0deg' }] }} />
            </Pressable>

            {isOpen ? (
              <View style={styles.detail}>
                <DetailRow label={level.label('Entry')} value={level.level(t.entryPrice, t.entryMarketCapUsd)} />
                <DetailRow label={level.label('Exit')} value={level.level(t.exitPrice, t.exitMarketCapUsd)} />
                <DetailRow label="Position size" value={formatUsd(t.positionSizeUsd)} />
                <DetailRow label="Proceeds" value={formatUsd(t.proceedsUsd)} />
                <DetailRow label="Simulated fees" value={formatUsd(t.fees)} />
                <DetailRow
                  label="Realized P&L"
                  value={`${formatUsd(t.realizedPnl, { sign: true })} (${formatPct(t.returnPct)})`}
                  color={pnlClass(t.realizedPnl) === 'up' ? Palette.green : Palette.red}
                />
                <DetailRow label="Buys / sells" value={`${t.buyCount ?? 0} / ${t.sellCount ?? 0}`} />
                <DetailRow label="Held" value={formatDuration(t.holdMs)} />
                <DetailRow label="Opened" value={formatDateTime(t.entryTime)} />
                <DetailRow label="Closed" value={formatDateTime(t.exitTime)} />
                <View style={styles.actions}>
                  <Btn label="Share P&L" variant="share" icon="share" onPress={() => onShare?.(shareClosed(t, level))} />
                </View>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

type Level = ReturnType<typeof levelFormatter>;

const shareOpen = (p: Position, level: Level) =>
  [
    `${p.symbol ?? 'Token'} open position`,
    `P&L ${formatUsd(p.unrealizedPnl, { sign: true })} (${formatPct(p.unrealizedPnlPct)})`,
    `Cost ${formatUsd(p.costBasis)} · ${level.label('entry')} ${level.level(p.averageEntryPrice, p.entryMarketCapUsd)}`,
    `${level.label('current')} ${level.level(p.currentPrice, p.marketCapUsd)}`,
    'Simulated fills at live prices · no real funds',
  ].join('\n');

const shareClosed = (t: ClosedTrade, level: Level) =>
  [
    `${t.symbol ?? 'Token'} closed trade`,
    `Realized ${formatUsd(t.realizedPnl, { sign: true })} (${formatPct(t.returnPct)})`,
    `${level.label('entry')} ${level.level(t.entryPrice, t.entryMarketCapUsd)} → ${level.label('exit')} ${level.level(t.exitPrice, t.exitMarketCapUsd)}`,
    `Held ${formatDuration(t.holdMs)}`,
    'Simulated fills at live prices · no real funds',
  ].join('\n');

const styles = StyleSheet.create({
  list: { gap: 8 },

  row: { borderRadius: Radius.md, borderWidth: 1, borderColor: Palette.line, overflow: 'hidden' },
  rowMainArea: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 },
  rowLead: { flex: 1, gap: 2, minWidth: 0 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { fontSize: 14, fontWeight: '800', color: Palette.textPrimary },
  here: {
    fontSize: 10,
    fontWeight: '700',
    color: Palette.paper,
    backgroundColor: Palette.paperT,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 5,
    overflow: 'hidden',
  },
  subLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  sub: { fontSize: 12, color: Palette.textSecondary, fontVariant: ['tabular-nums'] },

  rowValue: { alignItems: 'flex-end', gap: 1 },
  rowMain: { fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  rowSub: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },

  detail: { paddingHorizontal: 10, paddingBottom: 10, gap: 5, borderTopWidth: 1, borderTopColor: Palette.line, paddingTop: 8 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
});
