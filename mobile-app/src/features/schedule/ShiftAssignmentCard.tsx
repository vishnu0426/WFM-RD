import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/lib/a11y/tokens';

import { ShiftAssignment } from '@/api/types';

function formatRange(shiftStart: string, shiftEnd: string): string {
  const start = new Date(shiftStart);
  const end = new Date(shiftEnd);
  const dateLabel = start.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const timeOptions: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${dateLabel}, ${start.toLocaleTimeString(undefined, timeOptions)} – ${end.toLocaleTimeString(undefined, timeOptions)}`;
}

export function ShiftAssignmentCard({ assignment }: { assignment: ShiftAssignment }) {
  const rangeLabel = formatRange(assignment.shiftStart, assignment.shiftEnd);
  const accessibilityLabel = assignment.isOvertime ? `${rangeLabel}, overtime` : rangeLabel;

  return (
    <View
      style={styles.card}
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={styles.rangeText}>{rangeLabel}</Text>
      {assignment.isOvertime ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Overtime</Text>
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
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rangeText: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '500',
  },
  badge: {
    backgroundColor: colors.warningBackground,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  badgeText: {
    color: colors.warningText,
    fontSize: 12,
    fontWeight: '700',
  },
});
