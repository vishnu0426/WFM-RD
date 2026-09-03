import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/lib/a11y/tokens';

/** Section-scoped empty state (Phase 7, docs/adr/0156) — see
 * `SectionLoadingState`'s own doc comment for why this isn't `flex: 1`. */
export function SectionEmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.container} accessible accessibilityRole="text">
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 6,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
});
