// Shared visual primitives, translated from the extension's PANEL_CSS: the card shell, the
// segmented tabs, the amount field, the CTA and the status line. Screens compose these instead of
// re-declaring the palette in every stylesheet.

import { Palette, Radius, bordered, card } from '@/constants/paper';
import { Icon, type IconName } from '@/components/icons';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

export function Card({ children, style, tone }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: 'paper' | 'profit' | 'loss' }) {
  const borderColor =
    tone === 'paper' ? Palette.paperLine : tone === 'profit' ? 'rgba(33, 201, 94, 0.35)' : tone === 'loss' ? 'rgba(255, 98, 46, 0.35)' : undefined;
  return <View style={[styles.card, borderColor && { borderColor }, style]}>{children}</View>;
}

type ButtonVariant = 'buy' | 'sell' | 'primary' | 'setup' | 'ghost' | 'danger' | 'sm' | 'share';

export function Btn({
  label,
  onPress,
  variant = 'ghost',
  disabled,
  busy,
  icon,
  left,
  right,
  style,
  accessibilityLabel,
}: {
  label?: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  /** Node rendered before the label — the Google mark has its own colours, so it isn't an IconName. */
  left?: ReactNode;
  right?: ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const isSmall = variant === 'sm' || variant === 'share' || variant === 'danger';
  const background =
    variant === 'buy' ? Palette.green : variant === 'sell' ? Palette.red : variant === 'setup' ? Palette.paper : undefined;
  const foreground =
    variant === 'buy' || variant === 'sell' || variant === 'setup' ? Palette.bgPrimary : variant === 'danger' ? Palette.red : variant === 'share' ? Palette.paper : Palette.textPrimary;
  const ghost = variant === 'ghost' || variant === 'sm' || variant === 'share' || variant === 'danger';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        isSmall ? styles.btnSmall : styles.btnLarge,
        ghost && styles.btnGhost,
        ghost && !isSmall && bordered(),
        background && { backgroundColor: background },
        variant === 'sm' && { backgroundColor: Palette.bgSecondary },
        (disabled || busy) && styles.btnDisabled,
        pressed && !disabled && { opacity: 0.85 },
        style,
      ]}>
      {left}
      {busy ? <ActivityIndicator color={foreground} size="small" /> : null}
      {icon ? <Icon name={icon} size={isSmall ? 13 : 16} color={foreground} /> : null}
      {label ? <Text style={[styles.btnLabel, isSmall && styles.btnLabelSmall, { color: foreground }]}>{label}</Text> : null}
      {right}
    </Pressable>
  );
}

/** Segmented tabs: Buy/Sell, Open/Closed, $ / MC, All/Buys/Sells. */
export function SegTabs<T extends string>({
  options,
  value,
  onChange,
  accent = 'paper',
  style,
}: {
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  accent?: 'paper' | 'buy' | 'sell' | 'plain';
  style?: StyleProp<ViewStyle>;
}) {
  const activeColor = accent === 'buy' ? Palette.green : accent === 'sell' ? Palette.red : accent === 'paper' ? Palette.paper : Palette.textPrimary;
  const activeBg = accent === 'buy' ? Palette.greenT : accent === 'sell' ? Palette.redT : Palette.paperT;

  return (
    <View style={[styles.seg, style]}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled: opt.disabled }}
            disabled={opt.disabled}
            onPress={() => onChange(opt.value)}
            style={[styles.segBtn, active && { backgroundColor: activeBg, borderColor: accent === 'paper' ? Palette.paperLine : Palette.lineStrong }]}>
            <Text style={[styles.segLabel, { color: active ? activeColor : Palette.textTertiary }]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function AmountField({
  value,
  onChange,
  hint,
  onSubmit,
  editable = true,
}: {
  value: string;
  onChange: (next: string) => void;
  hint: string;
  onSubmit?: () => void;
  editable?: boolean;
}) {
  const hasValue = Number(value) > 0;
  return (
    <View style={[styles.amount, hasValue && styles.amountHasValue]}>
      <Text style={[styles.amountDollar, hasValue && { color: Palette.textPrimary }]}>$</Text>
      <TextInput
        value={value}
        editable={editable}
        onChangeText={onChange}
        onSubmitEditing={onSubmit}
        keyboardType="decimal-pad"
        inputMode="decimal"
        returnKeyType="done"
        placeholder="0"
        placeholderTextColor={Palette.textTertiary}
        style={styles.amountInput}
        aria-label="Amount in USD"
      />
      <Text numberOfLines={1} style={[styles.amountHint, hasValue && { color: Palette.textSecondary }]}>
        {hint}
      </Text>
    </View>
  );
}

export function Field({ label, error, children, style }: { label: string; error?: string | null; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ gap: 6 }, style]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

export function Input(props: TextInputProps) {
  const { style, ...rest } = props;
  return <TextInput placeholderTextColor={Palette.textTertiary} style={[styles.input, style]} {...rest} />;
}

export function Banner({ kind, children }: { kind: 'ok' | 'err' | 'loss'; children: ReactNode }) {
  const bg = kind === 'ok' ? Palette.greenT : Palette.redT;
  const fg = kind === 'ok' ? Palette.green : Palette.red;
  return (
    <View style={[styles.banner, { backgroundColor: bg }]}>
      <Text style={[styles.bannerText, { color: fg }]}>{children}</Text>
    </View>
  );
}

export function Stat({ label, value, hint, color }: { label: string; value: ReactNode; hint?: string; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color && { color }]}>{value}</Text>
      {hint ? <Text style={styles.statHint}>{hint}</Text> : null}
    </View>
  );
}

export function StatGrid({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, { flexDirection: 'row', flexWrap: 'wrap', padding: 4 }, style]}>{children}</View>;
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
    </View>
  );
}

export function Skeleton({ height = 70, style }: { height?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.skeleton, { height }, style]} />;
}

export function StatusRow({
  text,
  danger,
  expandable,
  expanded,
  onToggle,
  icon,
  children,
}: {
  text: string;
  danger?: boolean;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  const fg = danger ? Palette.red : Palette.paper;
  const bg = danger ? Palette.redT : Palette.paperT;
  const border = danger ? 'rgba(255, 98, 46, 0.3)' : Palette.paperLine;
  return (
    <View style={[styles.status, { backgroundColor: bg, borderColor: border }]}>
      <Pressable
        onPress={expandable ? onToggle : undefined}
        disabled={!expandable}
        accessibilityRole={expandable ? 'button' : undefined}
        accessibilityState={{ expanded: expanded ?? false }}
        style={styles.statusRow}>
        <View style={{ marginRight: 8 }}>{icon ?? <Icon name="warning" size={16} color={fg} />}</View>
        <Text numberOfLines={1} style={[styles.statusText, { color: fg }]}>
          {text}
        </Text>
        {expandable ? <Icon name="chevron" size={16} color={fg} style={{ opacity: 0.8, transform: [{ rotate: expanded ? '180deg' : '0deg' }] }} /> : null}
      </Pressable>
      {expanded && children ? <View style={styles.statusBody}>{children}</View> : null}
    </View>
  );
}

/** Label / value row used inside the expandable simulation details. */
export function DetailRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, color && { color }]}>{value}</Text>
    </View>
  );
}

export const textStyles = StyleSheet.create({
  num: { fontVariant: ['tabular-nums'] },
  up: { color: Palette.green },
  down: { color: Palette.red },
  muted: { color: Palette.textSecondary },
});

export function Num({ children, color, size = 14, weight = '700', style }: { children: ReactNode; color?: string; size?: number; weight?: TextStyle['fontWeight']; style?: StyleProp<TextStyle> }) {
  return <Text style={[{ fontVariant: ['tabular-nums'], fontSize: size, fontWeight: weight, color: color ?? Palette.textPrimary }, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  card: { ...card, padding: 8, gap: 8 },

  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  btnLarge: { height: 48, paddingHorizontal: 16 },
  btnSmall: { height: 32, paddingHorizontal: 12, borderRadius: Radius.sm, gap: 6 },
  btnGhost: { backgroundColor: Palette.bgSecondary },
  btnDisabled: { opacity: 0.55 },
  btnLabel: { fontSize: 16, fontWeight: '700' },
  btnLabelSmall: { fontSize: 13 },

  seg: {
    flexDirection: 'row',
    gap: 4,
    padding: 3,
    borderRadius: 10,
    backgroundColor: Palette.bgSecondary,
    borderWidth: 1,
    borderColor: Palette.line,
    alignSelf: 'flex-start',
  },
  segBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  segLabel: { fontSize: 13, fontWeight: '600' },

  amount: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 72,
    paddingHorizontal: 16,
    borderRadius: Radius.md,
    backgroundColor: Palette.bgSecondary,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  amountHasValue: { borderColor: Palette.lineStrong },
  amountDollar: { fontSize: 30, fontWeight: '500', color: Palette.textTertiary },
  amountInput: {
    flex: 1,
    minWidth: 0,
    color: Palette.textPrimary,
    fontSize: 30,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    padding: 0,
  },
  amountHint: { fontSize: 13, fontWeight: '500', color: Palette.textTertiary, maxWidth: 140, textAlign: 'right' },

  fieldLabel: { fontSize: 12, fontWeight: '600', color: Palette.textSecondary },
  input: {
    backgroundColor: Palette.bgSecondary,
    borderWidth: 1,
    borderColor: Palette.lineStrong,
    borderRadius: Radius.sm,
    color: Palette.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  errorText: { fontSize: 12, color: Palette.red },

  banner: { borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12 },
  bannerText: { fontSize: 13, fontWeight: '500' },

  stat: { flexBasis: '33.33%', minWidth: 100, flexGrow: 1, padding: 10, gap: 2 },
  statLabel: { fontSize: 12, color: Palette.textSecondary },
  statValue: { fontSize: 15, fontWeight: '700', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  statHint: { fontSize: 11, color: Palette.textTertiary },

  empty: { padding: 16, alignItems: 'center', gap: 2 },
  emptyTitle: { fontSize: 14, fontWeight: '700', color: Palette.textPrimary },
  emptyBody: { fontSize: 13, color: Palette.textSecondary, textAlign: 'center' },

  skeleton: {
    borderRadius: 14,
    backgroundColor: 'rgba(203, 208, 235, 0.08)',
  },

  status: { borderRadius: Radius.md, borderWidth: 1, overflow: 'hidden' },
  statusRow: { flexDirection: 'row', alignItems: 'center', padding: 10 },
  statusText: { flex: 1, fontSize: 13, fontWeight: '700' },
  statusBody: { paddingHorizontal: 12, paddingBottom: 12, gap: 6 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  detailLabel: { fontSize: 13, color: Palette.textSecondary, flexShrink: 1 },
  detailValue: { fontSize: 13, fontWeight: '500', color: Palette.textPrimary, fontVariant: ['tabular-nums'], textAlign: 'right' },
});
