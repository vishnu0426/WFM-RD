import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/Button';
import { ManualEntryNotice } from '@/components/ui/ManualEntryNotice';
import { ConflictBanner } from '@/features/attendance/ConflictBanner';
import { useCurrentIdentity } from '@/identity/useCurrentIdentity';
import { colors } from '@/lib/a11y/tokens';
import { getMobileEssApiBaseUrl } from '@/offlineQueue/mobileEssConfig';
import { queueLeaveRequest } from '@/offlineQueue/leaveRequest';
import { syncPendingActions } from '@/offlineQueue/syncEngine';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function LeaveRequestScreen() {
  const identity = useCurrentIdentity();
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [dateRangeStart, setDateRangeStart] = useState('');
  const [dateRangeEnd, setDateRangeEnd] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const validate = (): string | null => {
    if (!leaveTypeId.trim() || !dateRangeStart.trim() || !dateRangeEnd.trim()) {
      return 'All fields are required.';
    }
    if (!DATE_PATTERN.test(dateRangeStart) || !DATE_PATTERN.test(dateRangeEnd)) {
      return 'Dates must be in YYYY-MM-DD format.';
    }
    // Sync-queue-hygiene guardrail, not a forms nicety: without this,
    // attendance-leave-service's InvalidLeaveRequestError becomes a
    // reachable, deterministic conflict from this form's own input
    // (docs/adr/0153).
    if (dateRangeEnd < dateRangeStart) {
      return 'End date must not be before start date.';
    }
    return null;
  };

  const handleSubmit = async () => {
    setConfirmation(null);
    const validationError = validate();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await queueLeaveRequest({ leaveTypeId: leaveTypeId.trim(), dateRangeStart, dateRangeEnd });
      setConfirmation('Leave request queued.');
      setLeaveTypeId('');
      setDateRangeStart('');
      setDateRangeEnd('');
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
            Request Leave
          </Text>

          <ConflictBanner />

          <ManualEntryNotice text="There's no leave-type picker yet — enter the leave type id directly." />

          <View style={styles.field}>
            <Text style={styles.label}>Leave type ID</Text>
            <TextInput
              style={styles.input}
              value={leaveTypeId}
              onChangeText={setLeaveTypeId}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Leave type ID"
              editable={!isSubmitting}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Start date (YYYY-MM-DD)</Text>
            <TextInput
              style={styles.input}
              value={dateRangeStart}
              onChangeText={setDateRangeStart}
              placeholder="2026-09-01"
              accessibilityLabel="Start date"
              editable={!isSubmitting}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>End date (YYYY-MM-DD)</Text>
            <TextInput
              style={styles.input}
              value={dateRangeEnd}
              onChangeText={setDateRangeEnd}
              placeholder="2026-09-05"
              accessibilityLabel="End date"
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

          <Button label="Request Leave" onPress={handleSubmit} loading={isSubmitting} />
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
