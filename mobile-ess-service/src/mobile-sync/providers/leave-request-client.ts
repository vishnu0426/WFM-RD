import { Injectable } from '@nestjs/common';
import { LeaveRequestConflictError } from '../errors/leave-request-conflict.error';
import { LeaveRequestForwardFailedError } from '../errors/leave-request-forward-failed.error';

export interface LeaveRequestSubmitRequest {
  tenantId: string;
  employeeId: string;
  leaveTypeId: string;
  /** `YYYY-MM-DD`, matches `@IsDateString({strict:true})` on the target DTO. */
  dateRangeStart: string;
  dateRangeEnd: string;
}

const CONFLICT_CODES = new Set([
  'INSUFFICIENT_LEAVE_BALANCE',
  'LEAVE_BALANCE_NOT_FOUND',
  'BACKDATED_LEAVE_NOT_SUPPORTED',
  'INVALID_LEAVE_REQUEST',
]);

/**
 * Calls attendance-leave-service's real `POST /v1/leave/requests`
 * (`LeaveRequestService.requestLeave`'s synchronous conflict-check
 * pipeline, §2.2 rule 3) - a genuinely different transport than
 * `AttendanceClockEventClient`, even though it targets the same service.
 * This endpoint has NO `HmacSignatureGuard` - tenant comes from a plain
 * `X-Tenant-Id` header (`TenantContextService`/ADR-0014's placeholder),
 * `employeeId` is an unverified body field. No signing, no webhook
 * timestamp header (docs/adr/0153).
 */
@Injectable()
export class LeaveRequestClient {
  private readonly baseUrl = process.env.ATTENDANCE_LEAVE_SERVICE_URL ?? 'http://localhost:8300';

  async submit(request: LeaveRequestSubmitRequest): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/leave/requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': request.tenantId,
        },
        body: JSON.stringify({
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          dateRangeStart: request.dateRangeStart,
          dateRangeEnd: request.dateRangeEnd,
        }),
      });
    } catch (err) {
      throw new LeaveRequestForwardFailedError(503, `attendance-leave-service unreachable: ${(err as Error).message}`);
    }

    if (response.ok) {
      return;
    }

    const detail = await this.safeJson(response);
    const code = typeof detail?.error?.code === 'string' ? detail.error.code : undefined;
    const message = typeof detail?.error?.message === 'string' ? detail.error.message : await this.safeBody(response);

    if (code && CONFLICT_CODES.has(code)) {
      throw new LeaveRequestConflictError(code, message);
    }
    throw new LeaveRequestForwardFailedError(response.status, `HTTP ${response.status}: ${message}`);
  }

  private async safeBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '<unreadable body>';
    }
  }

  private async safeJson(response: Response): Promise<{ error?: { code?: string; message?: string } } | null> {
    try {
      return (await response.json()) as { error?: { code?: string; message?: string } };
    } catch {
      return null;
    }
  }
}
