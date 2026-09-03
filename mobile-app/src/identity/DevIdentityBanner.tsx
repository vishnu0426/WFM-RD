import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/lib/a11y/tokens';

const isProductionBuild = process.env.EXPO_PUBLIC_APP_ENV === 'production';

/**
 * Visible reminder that `employeeId` is still a hardcoded dev stub even
 * though sign-in is real as of Phase 2 (docs/adr/0150) — `tenantId` now
 * comes from the authenticated session's JWT claim; only `employeeId` is
 * still stubbed, since no `userId -> Employee` lookup exists anywhere in
 * the platform API yet. Rendered in every build except the production EAS
 * profile (see eas.json), so this can never be mistaken for a real,
 * fully-resolved identity.
 */
export function DevIdentityBanner() {
  if (isProductionBuild) {
    return null;
  }

  return (
    <View style={styles.banner} accessibilityRole="text">
      <Text style={styles.text}>DEV STUB — employeeId not resolved from session (ADR-0150)</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.warningBackground,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  text: {
    color: colors.warningText,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
});
