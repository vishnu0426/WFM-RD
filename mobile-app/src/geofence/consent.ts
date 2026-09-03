import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Local-only acknowledgment flag (docs/adr/0155), same shape as
 * `src/auth/biometric.ts`'s `isBiometricUnlockEnabled`/
 * `setBiometricUnlockEnabled`. Set once the employee has seen the
 * disclosure card — regardless of whether they went on to grant the OS
 * location permission, so declining never re-triggers the card every
 * session (their choice is honored, not re-nagged).
 */
const GEOFENCE_DISCLOSURE_ACKNOWLEDGED_KEY = 'agno_wfm_geofence_disclosure_acknowledged';

export async function isGeofenceDisclosureAcknowledged(): Promise<boolean> {
  return (await AsyncStorage.getItem(GEOFENCE_DISCLOSURE_ACKNOWLEDGED_KEY)) === 'true';
}

export async function setGeofenceDisclosureAcknowledged(acknowledged: boolean): Promise<void> {
  await AsyncStorage.setItem(GEOFENCE_DISCLOSURE_ACKNOWLEDGED_KEY, acknowledged ? 'true' : 'false');
}
