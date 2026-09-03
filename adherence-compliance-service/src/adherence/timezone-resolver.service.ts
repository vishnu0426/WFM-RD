import { Injectable, Logger } from '@nestjs/common';
import { EmployeeGrpcClientService } from '../grpc/employee-grpc-client.service';
import { CalendarGrpcClientService } from '../grpc/calendar-grpc-client.service';

const DEFAULT_TIMEZONE = 'UTC';
const ORG_UNIT_TIMEZONE_CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  timezone: string;
  expiresAt: number;
}

/**
 * §7 Phase 3/ADR-0099: resolves each employee to a real IANA timezone -
 * `employeeId -> orgUnitId` (`EmployeeGrpcClientService.getEmployeeOrgUnits`,
 * one batched call per tenant) then `orgUnitId -> timezone`
 * (`CalendarGrpcClientService.getWorkingTimeRules`, deduplicated -
 * employees sharing an org unit share one call, not one per employee).
 * `orgUnitId -> timezone` is cached (1h TTL, org-unit timezones change
 * essentially never) - `employeeId -> orgUnitId` is never cached, always
 * resolved fresh per tick, since an employee's org unit is real,
 * mutable, operational data (transfers happen).
 *
 * Fails toward `UTC`, per employee, never toward failing the whole tick -
 * a rollup job whose entire value is "runs reliably every 15 minutes"
 * must not go dark because one org unit's calendar lookup timed out. Every
 * fallback is logged, not silent.
 */
@Injectable()
export class TimezoneResolverService {
  private readonly logger = new Logger(TimezoneResolverService.name);
  private readonly orgUnitTimezoneCache = new Map<string, CacheEntry>();

  constructor(
    private readonly employeeGrpcClient: EmployeeGrpcClientService,
    private readonly calendarGrpcClient: CalendarGrpcClientService,
  ) {}

  /** Returns a map covering every id in `employeeIds` - ids that couldn't be resolved (any reason) map to `'UTC'`, never omitted. */
  async resolveTimezones(tenantId: string, employeeIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>(employeeIds.map((id) => [id, DEFAULT_TIMEZONE]));
    if (employeeIds.length === 0) {
      return result;
    }

    let orgUnitEntries: { employeeId: string; orgUnitId: string }[];
    try {
      orgUnitEntries = await this.employeeGrpcClient.getEmployeeOrgUnits(tenantId, employeeIds);
    } catch (err) {
      this.logger.warn(
        `getEmployeeOrgUnits unavailable for tenant=${tenantId} - falling back to UTC for ${employeeIds.length} employee(s): ${(err as Error).message}`,
      );
      return result;
    }

    const orgUnitIds = [...new Set(orgUnitEntries.map((e) => e.orgUnitId))];
    const timezoneByOrgUnit = new Map<string, string>();
    for (const orgUnitId of orgUnitIds) {
      timezoneByOrgUnit.set(orgUnitId, await this.resolveOrgUnitTimezone(tenantId, orgUnitId));
    }

    for (const entry of orgUnitEntries) {
      const timezone = timezoneByOrgUnit.get(entry.orgUnitId);
      if (timezone) {
        result.set(entry.employeeId, timezone);
      }
    }
    return result;
  }

  private async resolveOrgUnitTimezone(tenantId: string, orgUnitId: string): Promise<string> {
    const cacheKey = `${tenantId}:${orgUnitId}`;
    const cached = this.orgUnitTimezoneCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.timezone;
    }

    try {
      const today = new Date().toISOString().slice(0, 10);
      const rules = await this.calendarGrpcClient.getWorkingTimeRules({
        tenantId,
        orgUnitId,
        fromDate: today,
        toDate: today,
      });
      const timezone = rules.timezone || DEFAULT_TIMEZONE;
      this.orgUnitTimezoneCache.set(cacheKey, { timezone, expiresAt: Date.now() + ORG_UNIT_TIMEZONE_CACHE_TTL_MS });
      return timezone;
    } catch (err) {
      this.logger.warn(
        `getWorkingTimeRules unavailable for tenant=${tenantId} orgUnit=${orgUnitId} - falling back to UTC: ${(err as Error).message}`,
      );
      return DEFAULT_TIMEZONE;
    }
  }
}
