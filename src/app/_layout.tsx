import { useEffect } from 'react';

import { Palette } from '@/constants/paper';
import { AppProvider } from '@/state/app';
import { DarkTheme, Stack, ThemeProvider, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AlertOverlay } from '@/components/alert-toast';
import { initPushHandlers } from '@/lib/notifications';

SplashScreen.preventAutoHideAsync();

/** The extension is dark-only, so the navigation theme is pinned to the same palette. */
const PaperTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: Palette.accent,
    background: Palette.bgPrimary,
    card: Palette.bgSecondary,
    text: Palette.textPrimary,
    border: Palette.line,
    notification: Palette.red,
  },
};

export default function RootLayout() {
  const router = useRouter();

  // System push (dev builds only — Expo Go dropped remote push in SDK 53): a tapped push
  // opens Trade with its token. In Expo Go this is a safe no-op.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void initPushHandlers((data) => {
      router.push(`/trade?address=${encodeURIComponent(data.address ?? '')}${data.symbol ? `&symbol=${encodeURIComponent(data.symbol)}` : ''}` as never);
    }).then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, [router]);

  return (
    <ThemeProvider value={PaperTheme}>
      <AppProvider>
        <AnimatedSplashOverlay />
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: Palette.bgPrimary },
            animation: 'slide_from_right',
          }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="settings" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="alerts" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        </Stack>
        <AlertOverlay />
      </AppProvider>
    </ThemeProvider>
  );
}
