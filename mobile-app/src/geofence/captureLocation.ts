import * as Location from 'expo-location';

export interface CapturedLocation {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

/**
 * Docs/adr/0155. Never throws — returns `null` on any denial/error
 * (permission not granted, GPS unavailable, timeout), same "must never
 * block clocking in" posture `useRegisterDeviceOnAuth` already takes
 * toward push registration failures. Deliberately does NOT request
 * permission here — that only happens once, in the disclosure gate's own
 * "Acknowledge" action (`useGeofenceGate`); this function only reads the
 * already-granted state.
 */
export async function captureClockEventLocation(): Promise<CapturedLocation | null> {
  try {
    const permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) {
      return null;
    }
    const position = await Location.getCurrentPositionAsync();
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
    };
  } catch {
    return null;
  }
}
