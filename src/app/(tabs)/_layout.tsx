import { Tabs } from 'expo-router';

import { Icon, type IconName } from '@/components/icons';
import { Palette } from '@/constants/paper';

const ICONS: Record<string, IconName> = {
  trade: 'lightning',
  fomo: 'trendUp',
  photon: 'target',
  portfolio: 'wallet',
  history: 'history',
  style: 'chart',
};

/** The side panel's four views, as a bottom bar — the panel's stacked sections in one thumb reach. */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Palette.paper,
        tabBarInactiveTintColor: Palette.textTertiary,
        tabBarStyle: {
          backgroundColor: Palette.bgSecondary,
          borderTopColor: Palette.line,
          borderTopWidth: 1,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}>
      <Tabs.Screen
        name="trade"
        options={{
          title: 'Trade',
          tabBarIcon: ({ color, size }) => <Icon name={ICONS.trade} size={size ?? 20} color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="fomo"
        options={{
          title: 'FOMO',
          tabBarIcon: ({ color, size }) => <Icon name={ICONS.fomo} size={size ?? 20} color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="photon"
        options={{
          title: 'Photon',
          tabBarIcon: ({ color, size }) => <Icon name={ICONS.photon} size={size ?? 20} color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="portfolio"
        options={{
          title: 'Portfolio',
          tabBarIcon: ({ color, size }) => <Icon name={ICONS.portfolio} size={size ?? 20} color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ color, size }) => <Icon name={ICONS.history} size={size ?? 20} color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="style"
        options={{
          title: 'Style',
          tabBarIcon: ({ color, size }) => <Icon name={ICONS.style} size={size ?? 20} color={String(color)} />,
        }}
      />
    </Tabs>
  );
}
