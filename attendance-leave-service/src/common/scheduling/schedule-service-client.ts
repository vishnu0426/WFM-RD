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
 * Own copy of intraday-service's `ScheduleServiceClient` (ADR-0039
 * precedent: each *service* owns its cross-service clients rather than
 * sharing one) - same endpoint (ADR-0064), same header-trust
 * `X-Tenant-Id` convention, same built-in-`fetch` idiom. This is Module
 * 06's own explicit-assumption call (Phase 1 design doc, assumption 2):
 * REST, not gRPC, for the Module06->Module04 direction, since
 * scheduling-service exposes no gRPC server and this is the one existing,
 * proven precedent for calling it.
 *
 * Lives in `common/` (not under `attendance/`, where Phase 2 first wrote
 * it) because Phase 3's `LeaveConflictCheckService` needs the exact same
 * call - ADR-0039's "own copy per service" precedent is about not sharing
 * a client *across* services, not about duplicating it *within* one
 * service's two submodules.
 *
 * Enterprise readiness audit gap-fix: `X-Tenant-Id` alone used to be the
 * only header sent - correct when this was first written, but
 * scheduling-service's own GAP-08 fix later removed raw-header tenant
 * trust entirely (`get_tenant_context` now resolves `tenant_id` strictly
 * from a verified JWT), and this client was never updated to match. Every
 * call has been failing closed with a 401 ever since - `LeaveConflictCheckService`'s
 * own fail-closed design (its doc comment) means this silently blocked
 * *every* `requestLeave`/`submitBackdatedLeave` call, not just ones that
 * would have found a real conflict. Fix: relay the original caller's own
 * Bearer token (the incoming request's `Authorization` header, threaded
 * down from `LeaveRequestController`) - this call happens synchronously
 * inside handling that caller's own request, so their token is the
 * correct credential to present, not a separately-minted service-to-
 * service one this codebase has no machinery for yet. `authHeader` is
 * optional because `POST /v1/leave/requests` itself is unguarded
 * (this class's own controller doc comment) - an anonymous caller has no
 * token to relay, and gets the same 401-mapped `UpstreamUnavailableError`
 * as before, an unchanged (if still not ideal) outcome for that case.
 */
@Injectable()
export class ScheduleServiceClient {
  constructor(private readonly config: ConfigService) {}

  async getShiftAssignments(
    tenantId: string,
    employeeId: string,
    windowStart: Date,
    windowEnd: Date,
    authHeader?: string,
  ): Promise<EmployeeShiftAssignment[]> {
    const baseUrl = this.config.get<string>('SCHEDULING_SERVICE_URL', 'http://localhost:8100');
    const url = new URL(`${baseUrl}/v1/scheduling/employees/${employeeId}/shift-assignments`);
    url.searchParams.set('from', windowStart.toISOString());
    url.searchParams.set('to', windowEnd.toISOString());

    const headers: Record<string, string> = { 'X-Tenant-Id': tenantId };
    if (authHeader) headers['Authorization'] = authHeader;
    const response = await fetch(url, { method: 'GET', headers });
    if (!response.ok) {
      throw new Error(`scheduling-service GET ${url.pathname} returned ${response.status} for employee ${employeeId}`);
    }
    return (await response.json()) as EmployeeShiftAssignment[];
  }
}
