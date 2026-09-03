import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';

import { colors } from '@/lib/a11y/tokens';
import { useRegisterDeviceOnAuth } from '@/notifications/useRegisterDeviceOnAuth';

/**
 * Schedule (Phase 1), Profile (Phase 2, pulled forward for sign-out/
 * biometric toggle, docs/adr/0150), Leave and Marketplace (Phase 4,
 * docs/module-11-phase-4-design-doc.md) — filling the slot this file's
 * own Phase 1 comment reserved. Adherence and Hours (Phase 7,
 * docs/adr/0156) are pure read-only visibility screens, inserted after
 * Marketplace and before Profile.
 *
 * `useRegisterDeviceOnAuth()` (Phase 5, docs/adr/0154) is mounted here
 * rather than on a specific screen — it's tab-agnostic, and this layout
 * only ever mounts once per authenticated-session-start
 * (`Stack.Protected guard={status === 'authenticated'}`, app/_layout.tsx).
 */
export default function TabsLayout() {
  useRegisterDeviceOnAuth();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        headerShown: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Schedule',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="leave"
        options={{
          title: 'Leave',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="airplane-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="marketplace"
        options={{
          title: 'Marketplace',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="swap-horizontal-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="adherence"
        options={{
          title: 'Adherence',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="speedometer-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="hours"
        options={{
          title: 'Hours',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="time-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle-outline" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
