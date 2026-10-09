// Landing page for the OAuth redirect while running on web.
//
// The app normally lives at /(tabs); this route exists only so the Google redirect has somewhere
// to land during local verification, and so the result of the flow is readable instead of hidden
// in a 404's address bar. Nothing here runs on a device — `location` only exists on web.

import { router, useLocalSearchParams } from 'expo-router';
import { Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card } from '@/components/ui';
import { Palette } from '@/constants/paper';

type Found = { code?: string; access_token?: string; error?: string };

/** Query string for the code flow, fragment for the implicit flow — Google uses both. */
function readParams(): Found {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return {};
  const raw = `${window.location.search}${window.location.hash}`;
  const out: Found = {};
  for (const [k, v] of new URLSearchParams(raw.replace(/^[?#]/, ''))) {
    (out as Record<string, string>)[k] = v;
  }
  return out;
}

export default function AuthReturn() {
  const params = useLocalSearchParams();
  const found: Found = { ...readParams(), ...(params as Record<string, string>) };

  const value = found.access_token ?? found.code ?? null;

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>OAuth return</Text>
        <Text style={styles.sub}>
          This page only exists so the Google redirect has a place to land during local verification. It is not part of
          the app&apos;s normal flow.
        </Text>

        <Card style={{ padding: 14, gap: 10 }}>
          {found.error ? (
            <>
              <Text style={styles.label}>Google returned an error</Text>
              <Text style={styles.value}>{found.error}</Text>
            </>
          ) : value ? (
            <>
              <Text style={styles.label}>{found.access_token ? 'Access token' : 'Authorization code'}</Text>
              <Text selectable style={styles.value}>
                {value}
              </Text>
            </>
          ) : (
            <Text style={styles.sub}>No code or token in the URL yet. Start the sign-in flow and come back.</Text>
          )}
        </Card>

        <Btn label="Back to the app" variant="sm" onPress={() => router.replace('/')} style={{ alignSelf: 'stretch' }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Palette.bgPrimary },
  body: { padding: 20, gap: 14 },
  title: { fontSize: 22, fontWeight: '800', color: Palette.textPrimary },
  sub: { fontSize: 13, color: Palette.textSecondary, lineHeight: 19 },
  label: {
    fontSize: 11,
    fontWeight: '800',
    color: Palette.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  value: { fontSize: 13, color: Palette.textPrimary, lineHeight: 19 },
});
