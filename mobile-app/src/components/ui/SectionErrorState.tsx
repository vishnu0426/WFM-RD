import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { colors } from '@/lib/a11y/tokens';

/** Section-scoped error state (Phase 7, docs/adr/0156) — see
 * `SectionLoadingState`'s own doc comment for why this isn't `flex: 1`. */
export function SectionErrorState({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="alert">
        {title}
      </Text>
      <Button label="Retry" onPress={onRetry} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 10,
  },
  title: {
    color: colors.error,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
});
