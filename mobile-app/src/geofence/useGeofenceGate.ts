import { useCallback, useEffect, useState } from 'react';
import * as Location from 'expo-location';

import { getGeofenceConfig } from './geofenceConfig';
import { isGeofenceDisclosureAcknowledged, setGeofenceDisclosureAcknowledged } from './consent';

export interface GeofenceGateState {
  loading: boolean;
  /** Geofencing is configured for this employee's org unit. `false` for
   * every employee whose tenant/org unit hasn't opted in — the disclosure
   * card must never render in that case. */
  active: boolean;
  /** `active` and the employee hasn't yet acknowledged the disclosure. */
  needsDisclosure: boolean;
  /** Requests OS location permission and marks the disclosure
   * acknowledged regardless of the permission outcome — declining the OS
   * prompt still counts as "seen," never re-nagged (docs/adr/0155's
   * decline-is-unverified rule is enforced server-side, not by re-asking
   * here). */
  acknowledge: () => Promise<void>;
}

/**
 * Docs/adr/0155. Queries `GET /v1/mobile/geofence-config` once per mount;
 * a config-lookup failure fails open (never blocks the attendance
 * screen), same posture `GeofenceVerificationService` takes server-side.
 */
export function useGeofenceGate({ tenantId, employeeId }: { tenantId: string; employeeId: string }): GeofenceGateState {
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(false);
  const [needsDisclosure, setNeedsDisclosure] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      let enabled: boolean;
      try {
        enabled = (await getGeofenceConfig({ tenantId, employeeId })).enabled;
      } catch {
        enabled = false;
      }
      if (cancelled) {
        return;
      }
      if (!enabled) {
        setActive(false);
        setNeedsDisclosure(false);
        setLoading(false);
        return;
      }
      const acknowledged = await isGeofenceDisclosureAcknowledged();
      if (cancelled) {
        return;
      }
      setActive(true);
      setNeedsDisclosure(!acknowledged);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [tenantId, employeeId]);

  const acknowledge = useCallback(async () => {
    await Location.requestForegroundPermissionsAsync();
    await setGeofenceDisclosureAcknowledged(true);
    setNeedsDisclosure(false);
  }, []);

  return { loading, active, needsDisclosure, acknowledge };
}
