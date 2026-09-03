import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SectionEmptyState } from '@/components/ui/SectionEmptyState';
import { SectionErrorState } from '@/components/ui/SectionErrorState';
import { SectionLoadingState } from '@/components/ui/SectionLoadingState';
import { colors } from '@/lib/a11y/tokens';

import { AttendanceRecordCard } from './AttendanceRecordCard';
import { computeHoursWorked } from './computeHoursWorked';
import { LeaveBalanceCard } from './LeaveBalanceCard';
import { useLeaveBalances } from './useLeaveBalances';
import { usePayHours } from './usePayHours';

/**
 * "Hours," not "Pay" (docs/adr/0156) — no payroll/compensation data
 * exists anywhere in this platform; this screen shows hours worked and
 * leave balances only, never a dollar amount. Two independent sections,
 * same never-coupled discipline as `AdherenceScreen`.
 */
export function HoursScreen() {
  const hours = usePayHours();
  const balances = useLeaveBalances();

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.headerTitle} accessibilityRole="header">
          Hours
        </Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Hours worked</Text>
          {hours.isPending ? (
            <SectionLoadingState label="Loading your hours" />
          ) : hours.isError ? (
            <SectionErrorState title="Couldn't load your hours" onRetry={() => hours.refetch()} />
          ) : hours.data.length === 0 ? (
            <SectionEmptyState title="No attendance records in the last 14 days" />
          ) : (
            <AttendanceRecordCard summary={computeHoursWorked(hours.data)} />
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Leave balances</Text>
          {balances.isPending ? (
            <SectionLoadingState label="Loading your leave balances" />
          ) : balances.isError ? (
            <SectionErrorState title="Couldn't load your leave balances" onRetry={() => balances.refetch()} />
          ) : balances.data.length === 0 ? (
            <SectionEmptyState title="No leave balance on record" />
          ) : (
            balances.data.map((balance) => (
              <LeaveBalanceCard key={`${balance.leaveTypeId}-${balance.periodStart}`} balance={balance} />
            ))
          )}
        </View>
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
  headerTitle: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
});
