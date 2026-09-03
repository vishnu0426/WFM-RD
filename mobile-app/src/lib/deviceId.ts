import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

/**
 * An opaque, locally-generated installation identifier. `POST /v1/mobile/sync`'s
 * `deviceId` field accepts this as a plain client-supplied string, not
 * FK-validated against anything server-side. `registerDevice` (Phase 5,
 * ADR-0150/ADR-0157) also sends it - the real disambiguator between two
 * `DeviceRegistration` rows for the same employee/platform.
 */
const DEVICE_ID_KEY = 'agno_wfm_device_id';

export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }
  const deviceId = Crypto.randomUUID();
  await AsyncStorage.setItem(DEVICE_ID_KEY, deviceId);
  return deviceId;
}
