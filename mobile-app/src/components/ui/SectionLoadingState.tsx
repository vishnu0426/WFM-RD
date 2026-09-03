import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/lib/a11y/tokens';

/**
 * Section-scoped loading state (Phase 7, docs/adr/0156) — unlike
 * `features/schedule/LoadingState.tsx`, deliberately not `flex: 1`, since
 * a screen with multiple independent sections (each its own query) can't
 * let one section's loading state claim the whole screen.
 */
export function SectionLoadingState({ label }: { label: string }) {
  return (
    <View style={styles.container} accessible accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 8,
  },
  text: {
    color: colors.textSecondary,
    fontSize: 14,
  },
});
