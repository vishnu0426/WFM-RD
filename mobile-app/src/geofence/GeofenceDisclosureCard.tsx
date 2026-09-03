import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { colors } from '@/lib/a11y/tokens';

/**
 * Docs/adr/0155. Blocking (shown until acknowledged, not dismissible
 * without acting), rendered only when `useGeofenceGate()` reports
 * `needsDisclosure` — never shown to an employee whose org unit hasn't
 * opted into geofencing. The copy below is a placeholder: the source
 * spec's own instruction is that actual disclosure/consent language needs
 * separate legal/product review before this is enabled for any real
 * tenant (§5b) — this component defines the technical mechanism only.
 */
export function GeofenceDisclosureCard({ onAcknowledge }: { onAcknowledge: () => void | Promise<void> }) {
  return (
    <View style={styles.container} accessibilityRole="alert">
      <Text style={styles.title}>Location-based clock-in verification</Text>
      <Text style={styles.body}>
        {/* TODO: legal/product sign-off required before enabling for any real tenant (source spec §5b). */}
        Your employer has enabled location verification for clock-in and clock-out at this site. When you tap Clock
        In or Clock Out, your device&apos;s location is checked once against your site&apos;s configured boundary.
      </Text>
      <Button label="Acknowledge" onPress={() => onAcknowledge()} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.warningBackground,
    borderRadius: 8,
    padding: 16,
    gap: 12,
    marginHorizontal: 20,
    marginBottom: 12,
  },
  title: {
    color: colors.warningText,
    fontSize: 15,
    fontWeight: '700',
  },
  body: {
    color: colors.warningText,
    fontSize: 13,
  },
});
