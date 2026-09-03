import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getMe } from '@/api/identity';
import { useAuth } from '@/auth/AuthContext';
import {
  isBiometricAvailable,
  isBiometricUnlockEnabled,
  setBiometricUnlockEnabled,
} from '@/auth/biometric';
import { getAuthApiBaseUrl } from '@/auth/tokenGateway';
import { Button } from '@/components/ui/Button';
import { colors } from '@/lib/a11y/tokens';

function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => getMe(getAuthApiBaseUrl()),
  });
}

export default function ProfileScreen() {
  const { signOut } = useAuth();
  const { data: me, isPending, isError } = useMe();

  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);

  useEffect(() => {
    (async () => {
      const [available, enabled] = await Promise.all([
        isBiometricAvailable(),
        isBiometricUnlockEnabled(),
      ]);
      setBiometricAvailable(available);
      setBiometricEnabledState(enabled);
    })();
  }, []);

  const handleToggleBiometric = async (value: boolean) => {
    setBiometricEnabledState(value);
    await setBiometricUnlockEnabled(value);
  };

  const displayName = me ? [me.givenName, me.familyName].filter(Boolean).join(' ') || me.email : '';

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Profile
        </Text>

        {isPending ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : isError ? (
          <Text style={styles.muted}>Couldn&apos;t load profile details.</Text>
        ) : (
          <View style={styles.section}>
            <Text style={styles.name}>{displayName}</Text>
            <Text style={styles.muted}>{me?.email}</Text>
          </View>
        )}

        {biometricAvailable ? (
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Unlock with Face ID / Touch ID</Text>
            <Switch
              value={biometricEnabled}
              onValueChange={handleToggleBiometric}
              accessibilityLabel="Unlock with Face ID or Touch ID"
              accessibilityRole="switch"
            />
          </View>
        ) : (
          <Text style={styles.muted}>Biometric unlock isn&apos;t available on this device.</Text>
        )}

        <Button label="Sign Out" onPress={signOut} accessibilityHint="Signs you out of AGNO WFM" />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 20,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
  },
  section: {
    gap: 4,
  },
  name: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '600',
  },
  muted: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  rowLabel: {
    color: colors.textPrimary,
    fontSize: 16,
    flexShrink: 1,
    marginRight: 12,
  },
});
