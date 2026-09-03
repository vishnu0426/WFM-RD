import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Mirrors `scheduling-service`'s `EmployeeShiftAssignmentResponse` (ADR-0064) - camelCase, wire-shape identical. */
export interface EmployeeShiftAssignment {
  id: string;
  employeeId: string;
  scheduleId: string;
  shiftStart: string;
  shiftEnd: string;
  skillId: string | null;
  assignmentSource: string;
  isOvertime: boolean;
  locked: boolean;
  publishedAt: string;
}

/**
 * Thin client for scheduling-service's employee-scoped read endpoint
 * (ADR-0064) - same built-in-`fetch` idiom as the root app's
 * `WebhookDeliveryDispatcherService`. `X-Tenant-Id` header matches
 * scheduling-service's own current `TenantContextMiddleware` header-trust
 * convention - no cross-service JWT exists anywhere in this platform yet
 * for service-to-service calls (a real gap, not special-cased here).
 */
@Injectable()
export class ScheduleServiceClient {
  constructor(private readonly config: ConfigService) {}

  async getShiftAssignments(
    tenantId: string,
    employeeId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<EmployeeShiftAssignment[]> {
    const baseUrl = this.config.get<string>('SCHEDULING_SERVICE_URL', 'http://localhost:8100');
    const url = new URL(`${baseUrl}/v1/scheduling/employees/${employeeId}/shift-assignments`);
    url.searchParams.set('from', windowStart.toISOString());
    url.searchParams.set('to', windowEnd.toISOString());

    const response = await fetch(url, { method: 'GET', headers: { 'X-Tenant-Id': tenantId } });
    if (!response.ok) {
      throw new Error(`scheduling-service GET ${url.pathname} returned ${response.status} for employee ${employeeId}`);
    }
    return (await response.json()) as EmployeeShiftAssignment[];
  }
}
