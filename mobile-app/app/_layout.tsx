import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { colors } from '@/lib/a11y/tokens';
import { setupOnlineManager } from '@/lib/netInfo';
import { CACHE_BUSTER, asyncStoragePersister } from '@/lib/persistence';
import { queryClient } from '@/lib/queryClient';
import { useNotificationListeners } from '@/notifications/notificationListeners';

/** Route guard on AuthContext's state machine (docs/adr/0150). Each branch
 * is mutually exclusive via Stack.Protected's `guard`, so exactly one of
 * login/unlock/(tabs) is ever reachable for a given status. */
function RootNavigator() {
  const { status } = useAuth();

  if (status === 'bootstrapping') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status === 'unauthenticated'}>
        <Stack.Screen name="login" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'locked'}>
        <Stack.Screen name="unlock" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'authenticated'}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => {
    setupOnlineManager();
  }, []);
  // Not gated on auth (docs/adr/0154) - receiving/tapping a notification
  // isn't conditioned on being currently signed in.
  useNotificationListeners();

  return (
    <SafeAreaProvider>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister: asyncStoragePersister, buster: CACHE_BUSTER }}
      >
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
