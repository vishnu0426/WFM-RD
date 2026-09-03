import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Local-only preference for this phase — explicitly NOT the source spec's
 * `DeviceRegistration.biometric_enrolled` backend field, which doesn't
 * exist until Phase 5 (`registerDevice`). Named Phase 2 -> 5 seam, same
 * pattern as docs/adr/0149's identity stub (docs/adr/0150).
 */
const BIOMETRIC_UNLOCK_ENABLED_KEY = 'agno_wfm_biometric_unlock_enabled';

/** `expo-local-authentication` has no web implementation — `hasHardwareAsync()`
 * resolves falsy there, which naturally exercises the password-fallback
 * path under `npm run web` by default. Documented, not "fixed." */
export async function isBiometricAvailable(): Promise<boolean> {
  const [hasHardware, isEnrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hasHardware && isEnrolled;
}

/**
 * Gates access to the locally-stored refresh token only — biometric data
 * itself never leaves the device and never reaches the backend (source
 * spec §5a, non-negotiable). `disableDeviceFallback: true` because this
 * app provides its own password fallback screen (`app/unlock.tsx`'s "Use
 * password instead" link) rather than the OS's device-passcode prompt, to
 * keep "biometric gates a stored token, nothing more" the only mental model.
 */
export async function authenticateWithBiometrics(): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Unlock AGNO WFM',
    disableDeviceFallback: true,
  });
  return result.success;
}

export async function isBiometricUnlockEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(BIOMETRIC_UNLOCK_ENABLED_KEY)) === 'true';
}

export async function setBiometricUnlockEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(BIOMETRIC_UNLOCK_ENABLED_KEY, enabled ? 'true' : 'false');
}
