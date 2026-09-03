import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/lib/a11y/tokens';

/**
 * Visible, honest note that a field below is manual free-text entry
 * because no listing/picker read endpoint exists yet in the owning
 * module (docs/adr/0153) — not presented as if it were a deliberate UX
 * choice. Same spirit as `DevIdentityBanner`, a different component since
 * this is about a missing backend capability, not identity.
 */
export function ManualEntryNotice({ text }: { text: string }) {
  return (
    <View style={styles.container} accessibilityRole="text">
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: 12,
  },
  text: {
    color: colors.textSecondary,
    fontSize: 13,
  },
});
