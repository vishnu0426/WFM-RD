import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ClockEventConflictError } from '../errors/clock-event-conflict.error';
import { ClockEventForwardFailedError } from '../errors/clock-event-forward-failed.error';

export interface ClockEventForwardRequest {
  tenantId: string;
  sourceEventId: string;
  employeeId: string;
  eventType: 'clock_in' | 'clock_out';
  /** The sacred, device-captured timestamp (docs/adr/0152) - passed through
   * unchanged as `occurredAt`, which attendance-leave-service writes
   * directly into `AttendanceRecord.clockInAt`/`clockOutAt` with zero
   * server-side derivation (confirmed by reading `attendance-ingestion.
   * service.ts`). Never replaced with the sync/receive time. */
  occurredAt: string;
  /** ADR-0155: this service's own already-computed geofence verification
   * outcome (`GeofenceVerificationService.evaluate`) - `null` when
   * geofencing isn't enabled for the employee's org unit. Recorded
   * as-is by attendance-leave-service, never recomputed there. */
  geofenceVerified: boolean | null;
}

export interface ClockEventForwardResult {
  outcome: 'accepted' | 'duplicate';
  attendanceRecordId: string;
}

/**
 * Modeled directly on integration-hub-service's `IntradayActivityEventClient`
 * (`src/sync/relay/providers/intraday-activity-event-client.ts`) - the
 * platform's existing precedent for one service HMAC-signing a call to
 * another service's ingestion endpoint. Calls attendance-leave-service's
 * real `POST /v1/attendance/tenants/:tenantId/clock-events` (source spec
 * §2.2 rule 3: reuse the owning module's actual validation pipeline, never
 * a simplified mobile-specific approximation).
 *
 * `source: 'mobile_app'` - already a valid value in attendance-leave-
 * service's `AttendanceSource` enum and DB CHECK constraint, no server
 * change needed.
 */
@Injectable()
export class AttendanceClockEventClient {
  private readonly baseUrl = process.env.ATTENDANCE_LEAVE_SERVICE_URL ?? 'http://localhost:8300';
  private readonly secrets: Record<string, string> = JSON.parse(
    process.env.ATTENDANCE_LEAVE_INGESTION_HMAC_SECRETS ?? '{}',
  );

  async forward(request: ClockEventForwardRequest): Promise<ClockEventForwardResult> {
    const secret = this.secrets[request.tenantId];
    if (!secret) {
      throw new ClockEventForwardFailedError(
        500,
        `No ATTENDANCE_LEAVE_INGESTION_HMAC_SECRETS entry configured for tenant ${request.tenantId}.`,
      );
    }

    // Computed ONCE - this exact string is both the HMAC input and the
    // literal fetch body. The guard on the other end hashes raw request
    // bytes, so signing anything other than what's actually transmitted
    // would fail verification.
    const body = JSON.stringify({
      sourceEventId: request.sourceEventId,
      employeeId: request.employeeId,
      eventType: request.eventType,
      occurredAt: request.occurredAt,
      source: 'mobile_app',
      geofenceVerified: request.geofenceVerified,
    });
    const timestamp = Date.now();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/attendance/tenants/${request.tenantId}/clock-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agno-webhook-signature': `t=${timestamp},v1=${signature}`,
        },
        body,
      });
    } catch (err) {
      throw new ClockEventForwardFailedError(503, `attendance-leave-service unreachable: ${(err as Error).message}`);
    }

    if (response.status === 409) {
      const detail = await this.safeJson(response);
      throw new ClockEventConflictError(
        typeof detail?.error?.code === 'string' ? detail.error.code : 'ATTENDANCE_CONFLICT',
        typeof detail?.error?.message === 'string'
          ? detail.error.message
          : 'A conflicting attendance record already exists.',
      );
    }

    if (!response.ok) {
      throw new ClockEventForwardFailedError(
        response.status,
        `HTTP ${response.status}: ${await this.safeBody(response)}`,
      );
    }

    return (await response.json()) as ClockEventForwardResult;
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
