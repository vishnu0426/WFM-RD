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

/**
 * §7 Phase 3/ADR-0099: own copy of attendance-leave-service's identical
 * `CalendarGrpcClientService` - calls core's already-existing
 * `CalendarService.GetWorkingTimeRules` for `.timezone`, keyed by
 * `orgUnitId` (resolved via `EmployeeGrpcClientService`, ADR-0099's other
 * half). No core-side change needed for this half - `GetWorkingTimeRules`
 * already takes an `orgUnitId`.
 */
@Injectable()
export class CalendarGrpcClientService implements OnModuleInit {
  private client!: CalendarServiceClient;

  constructor(@Inject(CALENDAR_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<CalendarServiceClient>('CalendarService');
  }

  async getWorkingTimeRules(request: GetWorkingTimeRulesRequest): Promise<WorkingTimeRules> {
    return firstValueFrom(this.client.getWorkingTimeRules(request));
  }
}
