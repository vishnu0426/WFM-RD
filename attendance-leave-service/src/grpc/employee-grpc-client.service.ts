import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout, toArray } from 'rxjs';
import { EMPLOYEE_GRPC_PACKAGE } from './employee-grpc-client.constants';

export interface GetEmployeeIdForUserRequest {
  tenantId: string;
  userId: string;
}

export interface GetEmployeeIdForUserResponse {
  found: boolean;
  employeeId: string;
}

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
  getEmployeeIdForUser(request: GetEmployeeIdForUserRequest): Observable<GetEmployeeIdForUserResponse>;
  getSchedulableEmployees(request: GetSchedulableEmployeesRequest): Observable<SchedulableEmployee>;
}

const CALL_TIMEOUT_MS = 3000;

export class EmployeeGrpcClientUnavailableError extends Error {
  constructor(method: string, cause: unknown) {
    super(`EmployeeService.${method} unavailable: ${(cause as Error).message}`);
    this.name = 'EmployeeGrpcClientUnavailableError';
  }
}

/**
 * ADR-0150/ADR-0157. Own copy of mobile-ess-service's identical client
 * (itself calling the RPC core's `EmployeeGrpcController` exposes).
 * `getEmployeeIdForUser` resolves a JWT's `sub` claim (a `core.users.id`) to
 * the real `Employee.id` it is linked to, so
 * `EmployeeSessionVerificationService` can verify a client-supplied
 * `employeeId` path param actually belongs to the caller.
 *
 * `getSchedulableRoster` (Attendance & Leave Manager Views phase): this
 * service's first use of `GetSchedulableEmployees` - own copy of
 * `adherence-compliance-service`'s identical method, same
 * `orgUnitId -> employeeId[]` roster resolution `GET /v1/leave/requests`
 * and `GET /v1/attendance/exceptions` need to scope their queries to a
 * manager's org unit. Same RBAC-only posture as that precedent: this client
 * call filters *which* employees' rows come back, it does not itself verify
 * the caller actually manages `orgUnitId`.
 */
@Injectable()
export class EmployeeGrpcClientService implements OnModuleInit {
  private client!: EmployeeServiceClient;

  constructor(@Inject(EMPLOYEE_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<EmployeeServiceClient>('EmployeeService');
  }

  async getEmployeeIdForUser(tenantId: string, userId: string): Promise<string | null> {
    try {
      const response = await firstValueFrom(
        this.client.getEmployeeIdForUser({ tenantId, userId }).pipe(timeout(CALL_TIMEOUT_MS)),
      );
      return response.found ? response.employeeId : null;
    } catch (err) {
      throw new EmployeeGrpcClientUnavailableError('GetEmployeeIdForUser', err);
    }
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
      throw new EmployeeGrpcClientUnavailableError('GetSchedulableEmployees', err);
    }
  }
}
