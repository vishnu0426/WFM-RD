import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout } from 'rxjs';
import { EMPLOYEE_GRPC_PACKAGE } from './employee-grpc-client.constants';

export interface GetEmployeeOrgUnitsRequest {
  tenantId: string;
  employeeIds: string[];
}

export interface EmployeeOrgUnitEntry {
  employeeId: string;
  orgUnitId: string;
}

export interface GetEmployeeIdForUserRequest {
  tenantId: string;
  userId: string;
}

export interface GetEmployeeIdForUserResponse {
  found: boolean;
  employeeId: string;
}

interface EmployeeServiceClient {
  getEmployeeOrgUnits(request: GetEmployeeOrgUnitsRequest): Observable<{ entries: EmployeeOrgUnitEntry[] }>;
  getEmployeeIdForUser(request: GetEmployeeIdForUserRequest): Observable<GetEmployeeIdForUserResponse>;
}

const CALL_TIMEOUT_MS = 3000;

export class EmployeeGrpcClientUnavailableError extends Error {
  constructor(method: string, cause: unknown) {
    super(`EmployeeService.${method} unavailable: ${(cause as Error).message}`);
    this.name = 'EmployeeGrpcClientUnavailableError';
  }
}

/**
 * ADR-0155. Own copy of `adherence-compliance-service`'s identical
 * `getEmployeeOrgUnits` method (itself a copy of `shift-marketplace-service`'s
 * `EmployeeGrpcClientService` shape, pointed at a different RPC) -
 * narrowed to only this one method, since `GeofenceVerificationService`
 * has no need for `GetSchedulableEmployees`/`GetEmployeeSkillMatrix`.
 */
@Injectable()
export class EmployeeGrpcClientService implements OnModuleInit {
  private client!: EmployeeServiceClient;

  constructor(@Inject(EMPLOYEE_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<EmployeeServiceClient>('EmployeeService');
  }

  async getEmployeeOrgUnits(tenantId: string, employeeIds: string[]): Promise<EmployeeOrgUnitEntry[]> {
    if (employeeIds.length === 0) {
      return [];
    }
    try {
      const response = await firstValueFrom(
        this.client.getEmployeeOrgUnits({ tenantId, employeeIds }).pipe(timeout(CALL_TIMEOUT_MS)),
      );
      return response.entries ?? [];
    } catch (err) {
      throw new EmployeeGrpcClientUnavailableError('GetEmployeeOrgUnits', err);
    }
  }

  /**
   * ADR-0150/ADR-0157. Resolves the JWT's `sub` claim (a `userId`) to the
   * real `Employee.id` it is linked to, so callers can verify a
   * client-supplied `employeeId` actually belongs to the caller's own
   * session instead of trusting it as-is.
   */
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
}
