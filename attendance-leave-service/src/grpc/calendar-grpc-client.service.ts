import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';
import { CALENDAR_GRPC_PACKAGE } from './calendar-grpc-client.constants';

export interface GetWorkingTimeRulesRequest {
  tenantId: string;
  /** Empty string = the tenant-wide default calendar (core's own `CalendarGrpcController` convention). */
  orgUnitId: string;
  fromDate: string;
  toDate: string;
}

export interface WorkingTimeRules {
  countryCode: string;
  timezone: string;
  holidayDates: string[];
  standardBusinessHoursJson: string;
}

interface CalendarServiceClient {
  getWorkingTimeRules(request: GetWorkingTimeRulesRequest): Observable<WorkingTimeRules>;
}

/** Thin Promise-returning wrapper over the `CalendarService.GetWorkingTimeRules` gRPC client - same shape as `AuditGrpcClientService` (Phase 6). */
@Injectable()
export class CalendarGrpcClientService implements OnModuleInit {
  private client!: CalendarServiceClient;

  constructor(@Inject(CALENDAR_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<CalendarServiceClient>('CalendarService');
  }

  /** `holidayDates` is always `[]`, never thrown, when no calendar is configured for the tenant (core's own controller's documented empty-response shape) - a caller here treats "no calendar" and "calendar with no holidays in range" identically, which is correct: neither implies anything about this employee's leave-taking. */
  async getWorkingTimeRules(request: GetWorkingTimeRulesRequest): Promise<WorkingTimeRules> {
    return firstValueFrom(this.client.getWorkingTimeRules(request));
  }
}
