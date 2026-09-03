import { Injectable, Logger } from '@nestjs/common';
import { EmployeeGrpcClientService, EmployeeGrpcClientUnavailableError } from '../grpc/employee-grpc-client.service';
import { PolicyGrpcClientService, PolicyGrpcClientUnavailableError } from '../grpc/policy-grpc-client.service';
import { Coordinates, haversineDistanceMeters } from './haversine-distance';

const GEOFENCE_BOUNDARY_POLICY_TYPE = 'geofence_boundary';

export type Enforcement = 'soft' | 'hard';

interface GeofenceBoundary {
  center: Coordinates;
  radiusMeters: number;
  enforcement: Enforcement;
}

export interface GeofenceConfig {
  enabled: boolean;
  radiusMeters?: number;
  enforcement?: Enforcement;
}

export interface GeofenceEvaluation {
  enabled: boolean;
  verified: boolean | null;
  enforcement: Enforcement | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * ADR-0155 §B. Resolves employeeId -> orgUnitId (`EmployeeService.
 * GetEmployeeOrgUnits`) -> active `geofence_boundary` Policy for that org
 * unit (`PolicyService.GetActivePolicy`) -> a boundary check. **Fails
 * open** on either gRPC call being unreachable or on a malformed policy
 * `definition` - logged, treated as not-enabled. Deliberately diverges
 * from `AttendanceExceptionDetectionService`'s own precedent (which fails
 * closed on its `ScheduleServiceClient` call): geofencing is opt-in, and a
 * transient infra hiccup must never turn an ordinary clock-in into a
 * blocked or failed one - that philosophy already governs a real
 * out-of-bounds clock-in (soft by default), and should extend to
 * infrastructure failures too.
 *
 * Never exposes the boundary's center coordinates outside this service -
 * `getConfigForEmployee` (the mobile app's read path) returns only
 * `enabled`/`radiusMeters`/`enforcement`; the actual verification always
 * happens server-side, in `evaluate`.
 */
@Injectable()
export class GeofenceVerificationService {
  private readonly logger = new Logger(GeofenceVerificationService.name);

  constructor(
    private readonly employeeGrpcClient: EmployeeGrpcClientService,
    private readonly policyGrpcClient: PolicyGrpcClientService,
  ) {}

  async getConfigForEmployee(tenantId: string, employeeId: string): Promise<GeofenceConfig> {
    const boundary = await this.resolveActiveBoundary(tenantId, employeeId);
    if (!boundary) {
      return { enabled: false };
    }
    return { enabled: true, radiusMeters: boundary.radiusMeters, enforcement: boundary.enforcement };
  }

  async evaluate(tenantId: string, employeeId: string, location: Coordinates | undefined): Promise<GeofenceEvaluation> {
    const boundary = await this.resolveActiveBoundary(tenantId, employeeId);
    if (!boundary) {
      return { enabled: false, verified: null, enforcement: null };
    }
    if (!location) {
      // No location captured (permission declined, capture failed, or the
      // client didn't attempt it) - technically indistinguishable from a
      // real out-of-bounds location server-side, so treated identically
      // (ADR-0155's decline-is-unverified rule).
      return { enabled: true, verified: false, enforcement: boundary.enforcement };
    }
    const distance = haversineDistanceMeters(location, boundary.center);
    return { enabled: true, verified: distance <= boundary.radiusMeters, enforcement: boundary.enforcement };
  }

  private async resolveActiveBoundary(tenantId: string, employeeId: string): Promise<GeofenceBoundary | null> {
    const orgUnitId = await this.resolveOrgUnit(tenantId, employeeId);
    if (!orgUnitId) {
      return null;
    }
    return this.resolveBoundary(tenantId, orgUnitId);
  }

  private async resolveOrgUnit(tenantId: string, employeeId: string): Promise<string | null> {
    try {
      const entries = await this.employeeGrpcClient.getEmployeeOrgUnits(tenantId, [employeeId]);
      return entries[0]?.orgUnitId ?? null;
    } catch (err) {
      if (err instanceof EmployeeGrpcClientUnavailableError) {
        this.logger.warn(`Failed to resolve org unit for employee ${employeeId} - failing open: ${err.message}`);
        return null;
      }
      throw err;
    }
  }

  private async resolveBoundary(tenantId: string, orgUnitId: string): Promise<GeofenceBoundary | null> {
    let response;
    try {
      response = await this.policyGrpcClient.getActivePolicy(tenantId, GEOFENCE_BOUNDARY_POLICY_TYPE, orgUnitId);
    } catch (err) {
      if (err instanceof PolicyGrpcClientUnavailableError) {
        this.logger.warn(`Failed to resolve geofence policy for org unit ${orgUnitId} - failing open: ${err.message}`);
        return null;
      }
      throw err;
    }
    if (!response.found) {
      return null;
    }

    let definition: Record<string, unknown>;
    try {
      definition = JSON.parse(response.definitionJson) as Record<string, unknown>;
    } catch {
      this.logger.warn(`Geofence policy ${response.id} has unparseable definition JSON - treating as not enabled`);
      return null;
    }

    const centerLatitude = definition.centerLatitude;
    const centerLongitude = definition.centerLongitude;
    const radiusMeters = definition.radiusMeters;
    const enforcement = definition.enforcement === 'hard' ? 'hard' : 'soft';

    if (
      !isFiniteNumber(centerLatitude) ||
      !isFiniteNumber(centerLongitude) ||
      !isFiniteNumber(radiusMeters) ||
      radiusMeters <= 0
    ) {
      this.logger.warn(`Geofence policy ${response.id} has an invalid definition shape - treating as not enabled`);
      return null;
    }

    return { center: { latitude: centerLatitude, longitude: centerLongitude }, radiusMeters, enforcement };
  }
}
