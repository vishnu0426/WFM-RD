import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/lib/a11y/tokens';

export function EmptyState() {
  return (
    <View style={styles.container} accessible accessibilityRole="text">
      <Text style={styles.title}>No upcoming shifts</Text>
      <Text style={styles.subtitle}>
        You have no published shifts in the next two weeks.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },
});
