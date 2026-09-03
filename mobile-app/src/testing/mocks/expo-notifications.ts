/**
 * Full, explicit test-only replacement for `expo-notifications` - NOT a
 * `jest.requireActual()` partial merge (unlike `mocks/crypto.ts`).
 * jest-expo's own module-mock manifests (`moduleMocks/{expoModules,
 * internalExpoModules,thirdPartyModules}.js`) have no entry for this
 * package at all - confirmed before writing this, same class of gap that
 * silently broke `expo-crypto`'s `randomUUID()` in Phase 4 (resolved to
 * `undefined`, not a throw). Rather than trust an unverified `requireActual`
 * fallback for a native module with no JS-only implementation, this
 * provides exactly the functions `pushToken.ts`/`notificationListeners.ts`
 * call, with controllable state for tests.
 */
export enum AndroidImportance {
  MIN = 1,
  LOW = 2,
  DEFAULT = 3,
  HIGH = 4,
  MAX = 5,
}

let granted = true;
let pushTokenData = 'ExponentPushToken[test-token]';

export async function getPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted };
}

export async function requestPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted };
}

export async function setNotificationChannelAsync(): Promise<null> {
  return null;
}

export async function getExpoPushTokenAsync(): Promise<{ type: 'expo'; data: string }> {
  return { type: 'expo', data: pushTokenData };
}

export function addNotificationReceivedListener(): { remove: () => void } {
  return { remove: () => undefined };
}

export function addNotificationResponseReceivedListener(): { remove: () => void } {
  return { remove: () => undefined };
}

export function __setPermissionGranted(value: boolean): void {
  granted = value;
}

export function __setPushToken(value: string): void {
  pushTokenData = value;
}

export function __reset(): void {
  granted = true;
  pushTokenData = 'ExponentPushToken[test-token]';
}
