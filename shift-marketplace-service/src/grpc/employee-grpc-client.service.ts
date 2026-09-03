import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout, toArray } from 'rxjs';
import { EMPLOYEE_GRPC_PACKAGE } from './employee-grpc-client.constants';

export interface GetSchedulableEmployeesRequest {
  tenantId: string;
  orgUnitId: string;
  requiredSkillIds: string[];
  minContractHoursPerWeek: number;
  pageSize: number;
}

export interface SchedulableEmployee {
  employeeId: string;
  employeeNumber: string;
  orgUnitId: string;
  contractHoursPerWeek: number;
  employmentType: string;
  hireDate: string;
}

interface EmployeeServiceClient {
  getSchedulableEmployees(request: GetSchedulableEmployeesRequest): Observable<SchedulableEmployee>;
}

/** Same 3000ms budget/rationale as `SchedulingEligibilityGrpcClientService` - no existing precedent to inherit a different one from. */
const CALL_TIMEOUT_MS = 3000;

export class EmployeeGrpcClientUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`EmployeeService.GetSchedulableEmployees unavailable: ${(cause as Error).message}`);
    this.name = 'EmployeeGrpcClientUnavailableError';
  }
}

/**
 * Thin wrapper over the `EmployeeService` gRPC client
 * (`EmployeeGrpcClientModule`) - `GetSchedulableEmployees` is
 * server-streaming (`repeated SchedulableEmployee`, one message per
 * employee), so this collects the full stream via `toArray()` before
 * resolving, matching this service's own "one call, one Promise" async
 * style elsewhere rather than exposing the Observable directly.
 */
@Injectable()
export class EmployeeGrpcClientService implements OnModuleInit {
  private client!: EmployeeServiceClient;

  constructor(@Inject(EMPLOYEE_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<EmployeeServiceClient>('EmployeeService');
  }

  async getSchedulableRoster(tenantId: string, orgUnitId: string): Promise<SchedulableEmployee[]> {
    try {
      return await firstValueFrom(
        this.client
          .getSchedulableEmployees({
            tenantId,
            orgUnitId,
            requiredSkillIds: [],
            minContractHoursPerWeek: 0,
            pageSize: 200,
          })
          .pipe(toArray(), timeout(CALL_TIMEOUT_MS)),
      );
    } catch (err) {
      throw new EmployeeGrpcClientUnavailableError(err);
    }
  }
}
