import Constants from 'expo-constants';

import { apiPost } from '@/api/client';
import { isBiometricUnlockEnabled } from '@/auth/biometric';
import { getMobileEssApiBaseUrl } from '@/offlineQueue/mobileEssConfig';

interface RegisterDeviceResponse {
  id: string;
  deviceType: string;
  active: boolean;
  lastActiveAt: string;
}

/**
 * `POST /v1/mobile/devices` (ADR-0154, source spec §3.1's `registerDevice`
 * built as REST not GraphQL). Thin wrapper over the existing `apiPost`
 * (`@/api/client`, same tenant/bearer-token attachment every other
 * mobile-ess-service call already uses). Reads `isBiometricUnlockEnabled()`
 * (`@/auth/biometric`) for `biometricEnrolled` - the real backend home for
 * that file's already-documented Phase 2 -> 5 seam.
 *
 * `deviceType` is the caller's responsibility (`useRegisterDeviceOnAuth`,
 * which only calls this on ios/android - the entity's CHECK constraint has
 * no `web` value, and `npm run web` never has a real push token to send).
 *
 * `deviceId` (ADR-0150/ADR-0157, Module 11 Gap 2) is `getOrCreateDeviceId()`'s
 * stable per-install id (`@/lib/deviceId`, already used by `syncOfflineActions`)
 * - the real disambiguator between two devices of the same employee/platform,
 * closing `DeviceRegistration`'s original single-device-per-platform gap.
 */
export async function registerDevice(params: {
  tenantId: string;
  employeeId: string;
  deviceType: 'ios' | 'android';
  deviceId: string;
  pushToken: string;
}): Promise<RegisterDeviceResponse> {
  const biometricEnrolled = await isBiometricUnlockEnabled();

  return apiPost<RegisterDeviceResponse>(
    '/v1/mobile/devices',
    {
      employeeId: params.employeeId,
      deviceType: params.deviceType,
      deviceId: params.deviceId,
      pushToken: params.pushToken,
      appVersion: Constants.expoConfig?.version ?? 'unknown',
      biometricEnrolled,
    },
    { apiBaseUrl: getMobileEssApiBaseUrl(), tenantId: params.tenantId },
  );
}
