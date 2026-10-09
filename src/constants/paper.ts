// The extension's CSS custom properties (components/styles.js TOKENS_CSS) turned into React
// Native values, so the app reads like the panel it replaces. Violet marks practice mode and is
// the only accent; green/red carry profit/loss and buy/sell, amber is kept for real cautions.

export const Palette = {
  bgPrimary: '#060510',
  bgSecondary: '#12111a',
  bgTertiary: 'rgba(203, 208, 235, 0.1)',
  bgTertiarySolid: '#161522',
  line: 'rgba(203, 208, 235, 0.09)',
  lineStrong: 'rgba(203, 208, 235, 0.16)',
  textPrimary: '#f7f7f7',
  textSecondary: '#9899a3',
  textTertiary: '#5c5f68',
  green: '#21c95e',
  greenT: 'rgba(33, 201, 94, 0.2)',
  red: '#ff622e',
  redT: 'rgba(255, 98, 46, 0.14)',
  warning: '#ffc74f',
  warningT: 'rgba(255, 199, 79, 0.12)',
  paper: '#a896ff',
  paperT: 'rgba(168, 150, 255, 0.12)',
  paperLine: 'rgba(168, 150, 255, 0.28)',
  paperStrong: 'rgba(168, 150, 255, 0.55)',
  accent: '#a896ff',
  white: '#ffffff',
} as const;

/** Radial alpha for a profit/loss row tint — React Native has no CSS gradient shorthand. */
export const toneTint = (tone: 'profit' | 'loss' | '') =>
  tone === 'profit' ? 'rgba(33, 201, 94, 0.07)' : tone === 'loss' ? 'rgba(255, 98, 46, 0.07)' : 'transparent';

export const Radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

export const Type = {
  /** Money and addresses: tabular figures so digits line up column to column. */
  num: { fontVariant: ['tabular-nums'] as const },
} as const;

/** Matches the extension's border: a 1px line at the strong token value. */
export const bordered = (color: string = Palette.lineStrong) => ({
  borderWidth: 1,
  borderColor: color,
});

/** The card shell used everywhere: dark surface, 1px line, 12px radius. */
export const card = {
  backgroundColor: Palette.bgPrimary,
  borderRadius: Radius.md,
  ...bordered(),
} as const;
