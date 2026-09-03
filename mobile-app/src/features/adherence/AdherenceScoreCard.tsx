import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/lib/a11y/tokens';
import { AdherenceScoreToday } from '@/api/types';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function AdherenceScoreCard({ score }: { score: AdherenceScoreToday }) {
  const pctLabel = `${score.adherencePct.toFixed(1)}%`;

  return (
    <View
      style={styles.card}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${pctLabel} adherence today`}
    >
      <Text style={styles.pctText}>{pctLabel}</Text>
      <Text style={styles.detailText}>
        {score.majorDeviationCount} major deviation{score.majorDeviationCount === 1 ? '' : 's'}
      </Text>
      <Text style={styles.asOfText}>As of {formatTime(score.computedAt)}</Text>
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
  pctText: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '700',
  },
  detailText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  asOfText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
