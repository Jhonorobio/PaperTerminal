import { Palette } from '@/constants/paper';
import { peekLogo, tokenLogo } from '@/lib/logos';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

interface Props {
  symbol?: string | null;
  chainId?: string | null;
  address?: string | null;
  /** A known logo URL (the tracker sends one with the token) — skips the lookup. */
  logo?: string | null;
  size?: number;
  /** A round ring in the position's profit/loss tone, as the extension drew it. */
  tone?: 'profit' | 'loss' | '';
  style?: StyleProp<ViewStyle>;
}

/**
 * Letter avatar that swaps for the server's logo once it arrives — the same fallback order as
 * `avatar()` + `hydrateLogos()` in the extension, minus the mutation observer.
 */
export function TokenAvatar({ symbol, chainId, address, logo: logoProp, size = 38, tone = '', style }: Props) {
  const initial = (symbol || '?').replace(/^\$/, '').slice(0, 1).toUpperCase();
  const key = chainId && address ? `${chainId}:${address}` : '';
  // Cache hit is read during render; a miss is resolved once and remembered against its key, so
  // switching tokens can't leave one token's logo under another symbol.
  const [fetched, setFetched] = useState<{ key: string; url: string | null | undefined }>({ key, url: undefined });

  useEffect(() => {
    if (!key || logoProp || peekLogo(chainId, address) !== undefined) return;
    let live = true;
    void tokenLogo(chainId, address).then((url) => {
      if (live) setFetched({ key, url });
    });
    return () => {
      live = false;
    };
  }, [key, chainId, address, logoProp]);

  const cached = peekLogo(chainId, address);
  const logo = logoProp ?? (cached !== undefined ? cached : fetched.key === key ? fetched.url : undefined);

  const ring = tone ? (tone === 'profit' ? 'rgba(33, 201, 94, 0.45)' : 'rgba(255, 98, 46, 0.45)') : null;

  return (
    <View
      style={[
        styles.base,
        { width: size, height: size, borderRadius: size / 2 },
        ring && { borderWidth: 1, borderColor: ring },
        style,
      ]}>
      {logo ? (
        <Image source={{ uri: logo }} style={styles.image} contentFit="cover" transition={120} />
      ) : (
        <Text style={[styles.letter, { fontSize: Math.round(size * 0.4) }]}>{initial}</Text>
      )}
    </View>
  );
}

/** Small lowercase chip for the chain id, matching `.chain-tag`. */
export function ChainTag({ chain, style }: { chain?: string | null; style?: StyleProp<TextStyle> }) {
  if (!chain) return null;
  return <Text style={[styles.chainTag, style]}>{chain}</Text>;
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: Palette.bgTertiarySolid,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: { width: '100%', height: '100%' },
  letter: { color: Palette.textSecondary, fontWeight: '700' },
  chainTag: {
    fontSize: 10,
    fontWeight: '600',
    color: Palette.textSecondary,
    backgroundColor: Palette.bgTertiary,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
    textTransform: 'lowercase',
    marginRight: 6,
  },
});
