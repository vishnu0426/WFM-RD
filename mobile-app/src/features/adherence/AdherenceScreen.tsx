import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SectionEmptyState } from '@/components/ui/SectionEmptyState';
import { SectionErrorState } from '@/components/ui/SectionErrorState';
import { SectionLoadingState } from '@/components/ui/SectionLoadingState';
import { colors } from '@/lib/a11y/tokens';

import { AdherenceScoreCard } from './AdherenceScoreCard';
import { AgentLiveStateCard } from './AgentLiveStateCard';
import { useAdherenceScoreToday } from './useAdherenceScoreToday';
import { useAgentLiveState } from './useAgentLiveState';

/**
 * Two independent sections (docs/adr/0156) — each with its own query, its
 * own loading/error/empty/success state. Deliberately never coupled: one
 * section failing (e.g. intraday-service down) must never block the
 * other (e.g. adherence-compliance-service still succeeding) from
 * rendering. Read-only, no auto-polling — a visibility screen, not a
 * live dashboard.
 */
export function AdherenceScreen() {
  const liveState = useAgentLiveState();
  const scoreToday = useAdherenceScoreToday();

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.headerTitle} accessibilityRole="header">
          Adherence
        </Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Right now</Text>
          {liveState.isPending ? (
            <SectionLoadingState label="Loading your current status" />
          ) : liveState.isError ? (
            <SectionErrorState title="Couldn't load your current status" onRetry={() => liveState.refetch()} />
          ) : liveState.data === null ? (
            <SectionEmptyState title="No live status available" />
          ) : (
            <AgentLiveStateCard liveState={liveState.data} />
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Today&apos;s adherence</Text>
          {scoreToday.isPending ? (
            <SectionLoadingState label="Loading today's adherence" />
          ) : scoreToday.isError ? (
            <SectionErrorState title="Couldn't load today's adherence" onRetry={() => scoreToday.refetch()} />
          ) : scoreToday.data === null ? (
            <SectionEmptyState title="No adherence activity recorded yet today" />
          ) : (
            <AdherenceScoreCard score={scoreToday.data} />
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
