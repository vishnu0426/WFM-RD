import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/lib/a11y/tokens';
import { LeaveBalanceSummary } from '@/api/types';

/** No leave-type name lookup exists anywhere in the platform yet (same
 * confirmed gap Phase 4's `LeaveRequestScreen` already discloses for
 * `leaveTypeId` entry) - shown as a labeled id, not silently omitted. */
export function LeaveBalanceCard({ balance }: { balance: LeaveBalanceSummary }) {
  return (
    <View
      style={styles.card}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${balance.availableDays} days available for leave type ${balance.leaveTypeId}`}
    >
      <Text style={styles.leaveTypeText}>Leave type: {balance.leaveTypeId}</Text>
      <Text style={styles.availableText}>{balance.availableDays} days available</Text>
      <Text style={styles.detailText}>
        {balance.accruedDays} accrued · {balance.usedDays} used · {balance.pendingDays} pending
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
    gap: 4,
  },
  leaveTypeText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  availableText: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  detailText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
});
