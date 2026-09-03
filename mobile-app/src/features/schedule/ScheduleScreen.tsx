import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClockInOutControls } from '@/features/attendance/ClockInOutControls';
import { ConflictBanner } from '@/features/attendance/ConflictBanner';
import { DevIdentityBanner } from '@/identity/DevIdentityBanner';
import { colors } from '@/lib/a11y/tokens';
import { useOfflineSyncTrigger } from '@/offlineQueue/useOfflineSyncTrigger';

import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { LoadingState } from './LoadingState';
import { ShiftAssignmentCard } from './ShiftAssignmentCard';
import { useEmployeeShiftAssignments } from './useEmployeeShiftAssignments';

export function ScheduleScreen() {
  const { data, isPending, isError, refetch } = useEmployeeShiftAssignments();
  useOfflineSyncTrigger();

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <DevIdentityBanner />
      <View style={styles.header}>
        <Text style={styles.headerTitle} accessibilityRole="header">
          My schedule
        </Text>
      </View>
      <ClockInOutControls />
      <ConflictBanner />
      {isPending ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : data.length === 0 ? (
        <EmptyState />
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => <ShiftAssignmentCard assignment={item} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
});
