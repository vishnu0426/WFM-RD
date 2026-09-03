import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PasswordSignInForm } from '@/features/auth/PasswordSignInForm';
import { colors } from '@/lib/a11y/tokens';

export default function LoginScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <PasswordSignInForm title="Sign in" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
