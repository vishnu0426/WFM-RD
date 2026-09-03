import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout, toArray } from 'rxjs';
import { SCHEDULE_QUERY_GRPC_PACKAGE } from './schedule-query-grpc-client.constants';
import { DomainError } from '../common/errors/domain-error';

export interface ListPublishedShiftAssignmentsRequest {
  tenantId: string;
  employeeIds: string[];
  windowStart: string;
  windowEnd: string;
}

export interface ShiftAssignmentRecord {
  employeeId: string;
  scheduleId: string;
  shiftStart: string;
  shiftEnd: string;
  isOvertime: boolean;
}

interface ScheduleQueryServiceClient {
  listPublishedShiftAssignments(request: ListPublishedShiftAssignmentsRequest): Observable<ShiftAssignmentRecord>;
}

/** Own copy of `EmployeeGrpcClientService`'s budget/rationale - no reason for this call to wait longer than any other. */
const CALL_TIMEOUT_MS = 3000;

/**
 * Phase 8 (docs/adr/0107): was a bare `Error` subclass since Phase 5
 * (docs/adr/0103) first introduced it - every phase since flagged this as
 * a disclosed "surfaces as a generic 500" polish gap. Neither
 * `RuleChangeImpactPreviewService` nor `ComplianceReportService` catches
 * this specially (both are meant to fail closed), so this only changes
 * the error's shape at the REST/GraphQL boundary, not the fail-closed
 * behavior itself.
 */
export class ScheduleQueryGrpcClientUnavailableError extends DomainError {
  constructor(cause: unknown) {
    super(
      'SCHEDULE_QUERY_SERVICE_UNAVAILABLE',
      `ScheduleQueryService.ListPublishedShiftAssignments unavailable: ${(cause as Error).message}`,
    );
  }
}

/**
 * Thin wrapper over `ScheduleQueryService` (docs/adr/0103/0104) -
 * server-streaming, so this collects the full stream via `toArray()`
 * before resolving, same convention shift-marketplace-service's own
 * `EmployeeGrpcClientService.getSchedulableRoster` uses for the identical
 * shape of RPC.
 */
@Injectable()
export class ScheduleQueryGrpcClientService implements OnModuleInit {
  private client!: ScheduleQueryServiceClient;

  constructor(@Inject(SCHEDULE_QUERY_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<ScheduleQueryServiceClient>('ScheduleQueryService');
  }

  async listPublishedShiftAssignments(
    tenantId: string,
    employeeIds: string[],
    windowStart: Date,
    windowEnd: Date,
  ): Promise<ShiftAssignmentRecord[]> {
    if (employeeIds.length === 0) {
      return [];
    }
    try {
      return await firstValueFrom(
        this.client
          .listPublishedShiftAssignments({
            tenantId,
            employeeIds,
            windowStart: windowStart.toISOString(),
            windowEnd: windowEnd.toISOString(),
          })
          .pipe(toArray(), timeout(CALL_TIMEOUT_MS)),
      );
    } catch (err) {
      throw new ScheduleQueryGrpcClientUnavailableError(err);
    }
  }
}
