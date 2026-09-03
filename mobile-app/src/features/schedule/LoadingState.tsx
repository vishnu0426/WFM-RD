import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/lib/a11y/tokens';

export function LoadingState() {
  return (
    <View
      style={styles.container}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading your schedule"
    >
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={styles.text}>Loading your schedule…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  text: {
    color: colors.textSecondary,
    fontSize: 15,
  },
});
