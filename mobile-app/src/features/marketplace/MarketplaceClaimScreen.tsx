import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/Button';
import { ManualEntryNotice } from '@/components/ui/ManualEntryNotice';
import { ConflictBanner } from '@/features/attendance/ConflictBanner';
import { useCurrentIdentity } from '@/identity/useCurrentIdentity';
import { colors } from '@/lib/a11y/tokens';
import { getMobileEssApiBaseUrl } from '@/offlineQueue/mobileEssConfig';
import { queueMarketplaceClaim } from '@/offlineQueue/marketplaceClaim';
import { syncPendingActions } from '@/offlineQueue/syncEngine';

export function MarketplaceClaimScreen() {
  const identity = useCurrentIdentity();
  const [marketplacePostId, setMarketplacePostId] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    setConfirmation(null);
    if (!marketplacePostId.trim()) {
      setErrorMessage('Marketplace post ID is required.');
      return;
    }
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await queueMarketplaceClaim({ marketplacePostId: marketplacePostId.trim() });
      setConfirmation('Shift claim queued.');
      setMarketplacePostId('');
      void syncPendingActions({
        tenantId: identity.tenantId,
        employeeId: identity.employeeId,
        mobileEssApiBaseUrl: getMobileEssApiBaseUrl(),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.content}>
          <Text style={styles.title} accessibilityRole="header">
            Claim Open Shift
          </Text>

          <ConflictBanner />

          <ManualEntryNotice text="There's no open-shift browser yet — enter the marketplace post id directly." />

          <View style={styles.field}>
            <Text style={styles.label}>Marketplace post ID</Text>
            <TextInput
              style={styles.input}
              value={marketplacePostId}
              onChangeText={setMarketplacePostId}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Marketplace post ID"
              editable={!isSubmitting}
            />
          </View>

          {errorMessage ? (
            <Text style={styles.error} accessibilityRole="alert">
              {errorMessage}
            </Text>
          ) : null}
          {confirmation ? (
            <Text style={styles.confirmation} accessibilityRole="alert">
              {confirmation}
            </Text>
          ) : null}

          <Button label="Claim Shift" onPress={handleSubmit} loading={isSubmitting} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 16,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
  },
  field: {
    gap: 6,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.textPrimary,
    minHeight: 48,
  },
  error: {
    color: colors.error,
    fontSize: 14,
  },
  confirmation: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
});
