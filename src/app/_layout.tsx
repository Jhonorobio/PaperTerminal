import { Palette } from '@/constants/paper';
import { AppProvider } from '@/state/app';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';

import { AnimatedSplashOverlay } from '@/components/animated-icon';

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
        </Stack>
      </AppProvider>
    </ThemeProvider>
  );
}
