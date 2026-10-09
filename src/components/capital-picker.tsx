// "Choose your starting capital" picker, shared by first-time setup and account reset
// (the extension used one component for both, and so does the app).

import { Palette, Radius } from '@/constants/paper';
import { formatCompactUsd, formatUsd } from '@/lib/format';
import type { ServerConfig } from '@/lib/types';
import { Btn, Input } from '@/components/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';

const DEFAULT_PRESETS = [1000, 5000, 10000, 25000, 50000, 100000];

export interface CapitalChoice {
  selected: number | null;
  custom: string;
}

const limits = (config?: ServerConfig | null) => ({
  min: config?.minStartingBalance ?? 100,
  max: config?.maxStartingBalance ?? 1000000,
});

export function createCapitalChoice(config?: ServerConfig | null, current?: number | null): CapitalChoice {
  const presets = config?.startingBalancePresets?.length ? config.startingBalancePresets : DEFAULT_PRESETS;
  const preferred = current ?? config?.startingBalance ?? 10000;
  return presets.includes(preferred) ? { selected: preferred, custom: '' } : { selected: null, custom: String(preferred) };
}

export function capitalAmount(choice: CapitalChoice) {
  if (choice.custom !== '') {
    const n = Number(choice.custom);
    return Number.isFinite(n) ? n : NaN;
  }
  return choice.selected ?? NaN;
}

export function capitalError(choice: CapitalChoice, config?: ServerConfig | null) {
  const amount = capitalAmount(choice);
  const { min, max } = limits(config);
  if (!(amount > 0)) return 'Pick an amount or enter your own.';
  if (amount < min || amount > max) return `Choose between ${formatUsd(min, { decimals: 0 })} and ${formatUsd(max, { decimals: 0 })}.`;
  return null;
}

/** Presets are money, so they show compact ($25K); the custom field keeps full precision. */
export function CapitalPicker({
  config,
  choice,
  onChange,
  busy,
  onSubmit,
  submitLabel,
  error,
}: {
  config?: ServerConfig | null;
  choice: CapitalChoice;
  onChange: (next: CapitalChoice) => void;
  busy?: boolean;
  onSubmit: () => void;
  submitLabel: string;
  error?: string | null;
}) {
  const presets = config?.startingBalancePresets?.length ? config.startingBalancePresets : DEFAULT_PRESETS;
  const { min, max } = limits(config);
  const amount = capitalAmount(choice);
  const invalid = capitalError(choice, config);

  return (
    <View style={styles.wrap}>
      <View style={styles.grid}>
        {presets.map((value) => {
          const active = choice.custom === '' && choice.selected === value;
          return (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onChange({ selected: value, custom: '' })}
              style={[styles.opt, active && styles.optActive]}>
              <Text style={[styles.optLabel, active && { color: Palette.textPrimary }]}>{formatCompactUsd(value)}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.custom, choice.custom !== '' && styles.customActive]}>
        <Text style={styles.dollar}>$</Text>
        <Input
          value={choice.custom}
          onChangeText={(v) => {
            let clean = v.replace(/[^0-9.]/g, '');
            const dot = clean.indexOf('.');
            if (dot !== -1) clean = clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, '').slice(0, 2);
            onChange({ selected: null, custom: clean.slice(0, 10) });
          }}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="Custom amount, like 25,000…"
          style={styles.customInput}
          accessibilityLabel="Custom starting capital in USD"
        />
      </View>

      <Text style={styles.hint}>
        Between {formatUsd(min, { decimals: 0 })} and {formatUsd(max, { decimals: 0 })} in virtual USD
      </Text>

      <View style={styles.summary}>
        <Text style={styles.summaryText}>{invalid ?? `You'll start with ${formatUsd(amount)} in virtual cash`}</Text>
      </View>

      {error ? (
        <View style={styles.error}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Btn label={submitLabel} variant="setup" onPress={onSubmit} disabled={!!invalid} busy={busy} style={{ alignSelf: 'stretch' }} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  opt: {
    flexGrow: 1,
    minWidth: 92,
    paddingVertical: 10,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Palette.lineStrong,
    backgroundColor: Palette.bgSecondary,
    alignItems: 'center',
  },
  optActive: { backgroundColor: Palette.paperT, borderColor: Palette.paperStrong },
  optLabel: { fontSize: 14, fontWeight: '700', color: Palette.textSecondary, fontVariant: ['tabular-nums'] },

  custom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Palette.lineStrong,
    backgroundColor: Palette.bgSecondary,
    paddingHorizontal: 12,
  },
  customActive: { borderColor: Palette.accent },
  customInput: { flex: 1, backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, fontWeight: '600' },
  dollar: { fontSize: 16, color: Palette.textTertiary },

  hint: { fontSize: 12, color: Palette.textTertiary },
  summary: { padding: 10, borderRadius: Radius.sm, backgroundColor: Palette.bgSecondary, alignItems: 'center' },
  summaryText: { fontSize: 13, fontWeight: '600', color: Palette.textPrimary, fontVariant: ['tabular-nums'], textAlign: 'center' },

  error: { padding: 10, borderRadius: 10, backgroundColor: Palette.redT },
  errorText: { fontSize: 13, color: Palette.red },
});
