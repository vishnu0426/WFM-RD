import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/lib/a11y/tokens';
import { AgentLiveState } from '@/api/types';

function formatTime(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function AgentLiveStateCard({ liveState }: { liveState: AgentLiveState }) {
  const isDegraded = liveState.dataFreshness.status === 'degraded';
  const startedAt = formatTime(liveState.activityStartedAt);

  return (
    <View style={styles.card} accessible accessibilityRole="text">
      <Text style={styles.activityText}>{liveState.currentActivity ?? 'No current activity recorded'}</Text>
      {liveState.scheduledActivity ? (
        <Text style={styles.detailText}>Scheduled: {liveState.scheduledActivity}</Text>
      ) : null}
      {liveState.adherenceStatus ? (
        <Text style={styles.detailText}>Status: {liveState.adherenceStatus}</Text>
      ) : null}
      {startedAt ? <Text style={styles.detailText}>Since {startedAt}</Text> : null}
      {isDegraded ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Data may be delayed</Text>
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
  activityText: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '600',
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
