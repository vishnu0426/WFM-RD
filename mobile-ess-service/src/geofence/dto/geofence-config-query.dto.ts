import { IsUUID } from 'class-validator';

/**
 * `GET /v1/mobile/geofence-config`'s query params. `employeeId` is
 * client-supplied but no longer unverified - `GeofenceConfigController`
 * checks it against the caller's own session (ADR-0150/ADR-0157).
 */
export class GeofenceConfigQueryDto {
  @IsUUID()
  employeeId!: string;
}
