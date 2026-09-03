import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { colors } from '@/lib/a11y/tokens';

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.container} accessible={false}>
      <Text style={styles.title} accessibilityRole="alert">
        Couldn&apos;t load your schedule
      </Text>
      <Text style={styles.subtitle}>Check your connection and try again.</Text>
      <Button label="Retry" onPress={onRetry} accessibilityHint="Reloads your schedule" />
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
  title: {
    color: colors.error,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },
});
