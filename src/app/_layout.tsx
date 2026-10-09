import { useEffect } from 'react';

import { Palette } from '@/constants/paper';
import { AppProvider } from '@/state/app';
import { DarkTheme, Stack, ThemeProvider, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AlertOverlay } from '@/components/alert-toast';

SplashScreen.preventAutoHideAsync();
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

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

  // A system push (app closed or backgrounded) opens Trade with its token.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = (response.notification.request.content.data ?? {}) as { address?: string; symbol?: string | null };
      if (data.address) {
        router.push(`/trade?address=${encodeURIComponent(data.address)}${data.symbol ? `&symbol=${encodeURIComponent(data.symbol)}` : ''}` as never);
      }
    });
    return () => sub.remove();
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
