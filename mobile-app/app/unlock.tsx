import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/Button';
import { Touchable } from '@/components/ui/Touchable';
import { PasswordSignInForm } from '@/features/auth/PasswordSignInForm';
import { colors } from '@/lib/a11y/tokens';

export default function UnlockScreen() {
  const { unlockWithBiometric } = useAuth();
  const [showPasswordFallback, setShowPasswordFallback] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [failed, setFailed] = useState(false);

  if (showPasswordFallback) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <PasswordSignInForm title="Sign in" />
      </SafeAreaView>
    );
  }

  const handleUnlock = async () => {
    setFailed(false);
    setIsUnlocking(true);
    try {
      const success = await unlockWithBiometric();
      setFailed(!success);
    } finally {
      setIsUnlocking(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Welcome back
        </Text>
        <Text style={styles.subtitle}>Unlock to continue.</Text>

        {failed ? (
          <Text style={styles.error} accessibilityRole="alert">
            Couldn&apos;t unlock. Try again, or use your password.
          </Text>
        ) : null}

        <Button label="Unlock" onPress={handleUnlock} loading={isUnlocking} />

        <Touchable
          onPress={() => setShowPasswordFallback(true)}
          accessibilityRole="link"
          accessibilityLabel="Use password instead"
          style={styles.fallbackLink}
        >
          <Text style={styles.fallbackLinkText}>Use password instead</Text>
        </Touchable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 16,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 15,
    marginBottom: 8,
  },
  error: {
    color: colors.error,
    fontSize: 14,
    textAlign: 'center',
  },
  fallbackLink: {
    marginTop: 8,
  },
  fallbackLinkText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '600',
  },
});
