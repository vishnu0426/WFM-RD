/**
 * Full, explicit test-only replacement for `expo-location` - same
 * reasoning as `mocks/expo-notifications.ts`: jest-expo's own module-mock
 * manifests have no entry for this package at all, confirmed before
 * writing this rather than trusting an unverified auto-mock/`requireActual`
 * fallback for a native module.
 */
let granted = false;
let position = { coords: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 as number | null } };

export async function getForegroundPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted };
}

export async function requestForegroundPermissionsAsync(): Promise<{ granted: boolean }> {
  granted = true;
  return { granted };
}

export async function getCurrentPositionAsync(): Promise<typeof position> {
  return position;
}

export function __setPermissionGranted(value: boolean): void {
  granted = value;
}

export function __setPosition(coords: { latitude: number; longitude: number; accuracy: number | null }): void {
  position = { coords };
}

export function __reset(): void {
  granted = false;
  position = { coords: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 } };
}
