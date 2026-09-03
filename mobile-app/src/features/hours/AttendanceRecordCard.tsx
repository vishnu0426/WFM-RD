import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/lib/a11y/tokens';
import { HoursWorkedSummary } from './computeHoursWorked';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Shows the computed total plus, when currently clocked in, a separate
 * "in progress" line — never folded into the total (docs/adr/0156). */
export function AttendanceRecordCard({ summary }: { summary: HoursWorkedSummary }) {
  return (
    <View style={styles.card} accessible accessibilityRole="text">
      <Text style={styles.totalText}>{summary.totalHours.toFixed(1)} hours</Text>
      <Text style={styles.detailText}>
        Last 14 days · {summary.closedRecordCount} completed shift{summary.closedRecordCount === 1 ? '' : 's'}
      </Text>
      {summary.openRecord ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Clocked in since {formatTime(summary.openRecord.clockInAt)} — in progress</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 16,
    gap: 4,
  },
  totalText: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '700',
  },
  detailText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.warningBackground,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 6,
  },
  badgeText: {
    color: colors.warningText,
    fontSize: 12,
    fontWeight: '700',
  },
});
