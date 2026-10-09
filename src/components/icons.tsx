import { Palette } from '@/constants/paper';
import { ICON_PATHS, GOOGLE_PATHS } from './icons-data';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

export type IconName = keyof typeof ICON_PATHS;

interface IconProps {
  name: IconName;
  size?: number;
  /** React Native has no `currentColor`, so callers pass the colour explicitly. */
  color?: string;
  style?: StyleProp<ViewStyle>;
}

export function Icon({ name, size = 16, color = Palette.textSecondary, style }: IconProps) {
  const d = ICON_PATHS[name];
  if (!d) return null;
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256" fill={color} style={style}>
      <Path d={d} />
    </Svg>
  );
}

/** The Google mark keeps its official four colours, so it ignores `color`. */
export function GoogleIcon({ size = 18, style }: { size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" style={style}>
      {GOOGLE_PATHS.map((p, i) => (
        <Path key={i} d={p.d} fill={p.fill} />
      ))}
    </Svg>
  );
}
