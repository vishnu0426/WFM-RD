import { apiGet } from '@/api/client';
import { getMobileEssApiBaseUrl } from '@/offlineQueue/mobileEssConfig';

export interface GeofenceConfig {
  enabled: boolean;
  radiusMeters?: number;
  enforcement?: 'soft' | 'hard';
}

/**
 * `GET /v1/mobile/geofence-config` (docs/adr/0155). Lets the app decide
 * whether to show the disclosure gate / attempt location capture at all —
 * never shown to an employee whose org unit hasn't opted in. Never
 * receives the boundary's center coordinates — actual verification always
 * happens server-side, at sync time.
 */
export async function getGeofenceConfig(params: { tenantId: string; employeeId: string }): Promise<GeofenceConfig> {
  return apiGet<GeofenceConfig>(
    '/v1/mobile/geofence-config',
    { employeeId: params.employeeId },
    { apiBaseUrl: getMobileEssApiBaseUrl(), tenantId: params.tenantId },
  );
}
