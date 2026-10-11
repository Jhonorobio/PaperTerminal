// The extension read the active FOMO tab to know which token to trade; a standalone app has no
// tab, so the user pastes a link, "chain:address", or just a Solana address — and the last tokens
// opened are one tap away.

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { TokenAvatar } from '@/components/token-avatar';
import { Icon } from '@/components/icons';
import { Card } from '@/components/ui';
import { Palette, Radius } from '@/constants/paper';
import { parseManualAsset } from '@/lib/asset';
import { formatPrice } from '@/lib/format';
import { serverFeed } from '@/lib/market/server-feed';
import { fetchHistory, type AlertHistoryEntry } from '@/lib/notifications';
import { addRecentAsset } from '@/lib/storage';
import type { Asset } from '@/lib/types';
import { useApp } from '@/state/app';

// Both chip rows cap at five — enough to re-open what's fresh without pushing the
// panel below the fold.
const RECENTS_SHOWN = 5;
const ALERTS_SHOWN = 5;

/** One chip per token address: the newest alert for a token is the one that shows. */
function newestPerAddress(entries: AlertHistoryEntry[]): AlertHistoryEntry[] {
  const seen = new Set<string>();
  const out: AlertHistoryEntry[] = [];
  for (const e of entries) {
    if (!e?.address) continue;
    const key = e.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function TokenPicker({ value, onChange }: { value: Asset | null; onChange: (next: Asset | null) => void }) {
  const { recents, flash, settings } = useApp();
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Last tokens this device was alerted on: the server history seeds the row, live
  // pushes prepend while the app runs — the same server records both, so a remount
  // re-hydrates whatever the session saw.
  const [alerted, setAlerted] = useState<AlertHistoryEntry[]>([]);

  useEffect(() => {
    let alive = true;
    void fetchHistory(settings.serverBase, 50).then((items) => {
      if (alive) setAlerted((prev) => newestPerAddress([...prev, ...items]));
    });
    return () => {
      alive = false;
    };
  }, [settings.serverBase]);

  useEffect(() => {
    const unsubscribe = serverFeed.onAlert((data) => {
      const entry = data as AlertHistoryEntry;
      if (!entry?.address) return;
      setAlerted((prev) => newestPerAddress([entry, ...prev]));
    });
    return unsubscribe;
  }, []);

  // Before the field is touched it mirrors the selected token; afterwards it keeps whatever the
  // user is typing, so a half-typed address isn't overwritten by a background refresh.
  const key = value ? `${value.chain}:${value.address}` : '';
  const shown = dirty ? text : key;

  const submit = (raw: string) => {
    const parsed = parseManualAsset(raw);
    if (!parsed) {
      setError('Paste a fomo.family or DexScreener link, a Solana address, or chain:address.');
      return;
    }
    setError(null);
    setDirty(false);
    setText('');
    onChange(parsed);
    void addRecentAsset(parsed);
    flash('ok', `Trading ${parsed.chain}:${parsed.address.slice(0, 6)}…`);
  };

  const choose = (asset: Asset) => {
    setError(null);
    setDirty(false);
    setText('');
    onChange(asset);
    void addRecentAsset(asset);
  };

  return (
    <Card style={styles.card}>
      <Text style={styles.label}>Token</Text>

      <View style={[styles.inputRow, error ? styles.inputRowError : null]}>
        <TextInput
          value={shown}
          onChangeText={(v) => {
            setText(v);
            setDirty(true);
          }}
          onSubmitEditing={() => submit(shown)}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="fomo.family link, DexScreener link, or Solana address"
          placeholderTextColor={Palette.textTertiary}
          style={styles.input}
          accessibilityLabel="Token link or address"
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Use this token" onPress={() => submit(shown)} style={styles.go}>
          <Icon name="search" size={16} color={Palette.bgPrimary} />
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {recents.length ? (
        <View style={styles.recents}>
          <Text style={styles.recentsLabel}>Recent</Text>
          <View style={styles.chips}>
            {recents.slice(0, RECENTS_SHOWN).map((a) => {
              const key = `${a.chain}:${a.address}`.toLowerCase();
              const active = value && `${value.chain}:${value.address}`.toLowerCase() === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => choose(a)}
                  accessibilityRole="button"
                  style={[styles.chip, active && styles.chipActive]}>
                  <TokenAvatar symbol={a.symbol} chainId={a.chain} address={a.address} size={18} />
                  <Text style={[styles.chipText, active && { color: Palette.textPrimary }]}>
                    {a.symbol ?? `${a.address.slice(0, 4)}…`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {alerted.length ? (
        <View style={styles.recents}>
          <Text style={styles.recentsLabel}>Alertas</Text>
          <View style={styles.chips}>
            {alerted.slice(0, ALERTS_SHOWN).map((entry) => {
              // The server stores chains as 'sol'; the app speaks 'solana' (same map the
              // floating panel and the alert deep link use).
              const chain = !entry.chain || entry.chain === 'sol' ? 'solana' : entry.chain;
              const key = `${chain}:${entry.address}`.toLowerCase();
              const active = value && `${value.chain}:${value.address}`.toLowerCase() === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => choose({ chain, address: entry.address, symbol: entry.symbol })}
                  accessibilityRole="button"
                  style={[styles.chip, active && styles.chipActive]}>
                  <TokenAvatar symbol={entry.symbol} chainId={chain} address={entry.address} size={18} />
                  <Text style={[styles.chipText, active && { color: Palette.textPrimary }]}>
                    {entry.symbol ?? entry.name ?? `${entry.address.slice(0, 4)}…`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/** One-line market summary for the selected token, shown under the picker. */
export function TokenSummary({ asset, price }: { asset: Asset | null; price?: number | null }) {
  if (!asset) return null;
  return (
    <View style={styles.summary}>
      <TokenAvatar symbol={asset.symbol} chainId={asset.chain} address={asset.address} size={24} />
      <Text style={styles.summaryText}>
        {asset.symbol ?? `${asset.address.slice(0, 6)}…${asset.address.slice(-4)}`}
      </Text>
      <View style={{ flex: 1 }} />
      <Text style={styles.summaryPrice}>{price ? formatPrice(price) : ''}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 8, padding: 12 },
  label: { fontSize: 12, fontWeight: '700', color: Palette.textSecondary, textTransform: 'uppercase', letterSpacing: 1 },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Palette.lineStrong,
    backgroundColor: Palette.bgSecondary,
    paddingLeft: 12,
  },
  inputRowError: { borderColor: Palette.red },
  input: { flex: 1, color: Palette.textPrimary, fontSize: 14, paddingVertical: 10 },
  go: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    backgroundColor: Palette.paper,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  error: { fontSize: 12, color: Palette.red },

  recents: { gap: 6 },
  recentsLabel: { fontSize: 11, fontWeight: '700', color: Palette.textTertiary, textTransform: 'uppercase', letterSpacing: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Palette.line,
    backgroundColor: Palette.bgSecondary,
  },
  chipActive: { borderColor: Palette.paperStrong, backgroundColor: Palette.paperT },
  chipText: { fontSize: 12, fontWeight: '700', color: Palette.textSecondary },

  summary: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  summaryText: { fontSize: 14, fontWeight: '700', color: Palette.textPrimary },
  summaryPrice: { fontSize: 14, fontWeight: '700', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
});
