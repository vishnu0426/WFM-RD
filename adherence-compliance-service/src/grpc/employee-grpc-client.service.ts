import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout, toArray } from 'rxjs';
import { EMPLOYEE_GRPC_PACKAGE } from './employee-grpc-client.constants';

export interface GetEmployeeOrgUnitsRequest {
  tenantId: string;
  employeeIds: string[];
}

export interface EmployeeOrgUnitEntry {
  employeeId: string;
  orgUnitId: string;
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
  getEmployeeOrgUnits(request: GetEmployeeOrgUnitsRequest): Observable<{ entries: EmployeeOrgUnitEntry[] }>;
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
 * §7 Phase 3/ADR-0099: Module 08's first gRPC client of any kind - calls
 * core's `EmployeeService.GetEmployeeOrgUnits` (the RPC ADR-0099 adds to
 * close this module's own employee→org-unit gap), own copy of
 * shift-marketplace-service's identical `EmployeeGrpcClientService` shape,
 * pointed at a different RPC.
 *
 * Phase 5 (docs/adr/0104) adds `getSchedulableRoster` - the same client
 * binding (one `ClientsModule` registration per package, not per method;
 * `EmployeeService` already covers both RPCs), own copy of
 * shift-marketplace-service's identical `getSchedulableRoster` method -
 * `RuleChangeImpactPreview` needs "every employee in this org unit," the
 * same roster shift-marketplace-service's guardrail check already needed.
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
