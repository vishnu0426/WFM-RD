import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { Observable } from 'rxjs';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { EmployeesRepository } from '../../modules/employee/repositories/employees.repository';
import { EmployeeSkillsRepository } from '../../modules/skill/repositories/employee-skills.repository';

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

interface GetSchedulableEmployeesRequest {
  tenantId: string;
  orgUnitId: string;
  requiredSkillIds: string[];
  minContractHoursPerWeek: number;
  pageSize: number;
}

interface GetEmployeeSkillMatrixRequest {
  tenantId: string;
  employeeIds: string[];
}

interface GetEmployeeOrgUnitsRequest {
  tenantId: string;
  employeeIds: string[];
}

interface GetEmployeeIdForUserRequest {
  tenantId: string;
  userId: string;
}

/**
 * §3.3's `EmployeeService`. Internal gRPC surface for Scheduling/Forecasting
 * - the whole point of this boundary (§3.3's own rationale) is that those
 * services never touch `org.employees`/`org.employee_skills` directly, so
 * this contract's shape matters as much as any public API's. Tenant context
 * has no HTTP middleware to bind it here (ADR-0021) - each handler binds it
 * explicitly from the request message's own `tenant_id` field.
 */
@Controller()
export class EmployeeGrpcController {
  private readonly logger = new Logger(EmployeeGrpcController.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly employeesRepository: EmployeesRepository,
    private readonly employeeSkillsRepository: EmployeeSkillsRepository,
  ) {}

  /**
   * Server-streaming (§3.3: "define pagination/streaming behavior for large
   * org units - don't return an unbounded list"). Internally pages through
   * `EmployeesRepository.findSchedulablePage` in `pageSize`-sized chunks
   * (clamped to `MAX_PAGE_SIZE`) and emits one message per employee - a
   * small org unit just means a short-lived stream, not a different code path.
   */
  @GrpcMethod('EmployeeService', 'GetSchedulableEmployees')
  getSchedulableEmployees(request: GetSchedulableEmployeesRequest): Observable<Record<string, unknown>> {
    const pageSize = Math.min(request.pageSize > 0 ? request.pageSize : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    return new Observable((subscriber) => {
      this.tenantContext
        .run({ tenantId: request.tenantId }, async () => {
          try {
            let cursor: string | null = null;
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const page = await this.employeesRepository.findSchedulablePage(
                request.orgUnitId,
                request.requiredSkillIds ?? [],
                request.minContractHoursPerWeek ?? 0,
                cursor,
                pageSize,
              );
              if (page.length === 0) {
                break;
              }
              for (const employee of page) {
                subscriber.next({
                  employeeId: employee.id,
                  employeeNumber: employee.employeeNumber,
                  orgUnitId: employee.orgUnitId,
                  contractHoursPerWeek: Number(employee.contractHoursPerWeek),
                  employmentType: employee.employmentType,
                  // Module 07 (docs/adr/0088) - `Employee.hireDate` was
                  // already selected by `findSchedulablePage`'s `getMany()`
                  // (a full entity, not a partial select); this is the
                  // first RPC field to actually carry it across.
                  hireDate: employee.hireDate,
                });
              }
              cursor = page[page.length - 1].id;
              if (page.length < pageSize) {
                break;
              }
            }
            subscriber.complete();
          } catch (err) {
            this.logger.error(
              `GetSchedulableEmployees failed for tenant=${request.tenantId}: ${(err as Error).message}`,
            );
            subscriber.error(err);
          }
        })
        .catch((err) => subscriber.error(err));
    });
  }

  @GrpcMethod('EmployeeService', 'GetEmployeeSkillMatrix')
  async getEmployeeSkillMatrix(
    request: GetEmployeeSkillMatrixRequest,
  ): Promise<{ entries: Record<string, unknown>[] }> {
    return this.tenantContext.run({ tenantId: request.tenantId }, async () => {
      const rows = await this.employeeSkillsRepository.findForEmployees(request.employeeIds ?? []);
      return {
        entries: rows.map((row) => ({
          employeeId: row.employeeId,
          skillId: row.skillId,
          proficiencyLevel: row.proficiencyLevel,
          decayScore: Number(row.decayScore),
          expiryDate: row.expiryDate ?? '',
        })),
      };
    });
  }

  /** docs/adr/0099: closes Module 08's employee-id -> org-unit-id gap - sparse, same convention as `getEmployeeSkillMatrix` above. */
  @GrpcMethod('EmployeeService', 'GetEmployeeOrgUnits')
  async getEmployeeOrgUnits(request: GetEmployeeOrgUnitsRequest): Promise<{ entries: Record<string, unknown>[] }> {
    return this.tenantContext.run({ tenantId: request.tenantId }, async () => {
      const rows = await this.employeesRepository.findByIds(request.employeeIds ?? []);
      return {
        entries: rows.map((row) => ({
          employeeId: row.id,
          orgUnitId: row.orgUnitId,
        })),
      };
    });
  }

  /**
   * docs/adr/0150/docs/adr/0157: the cross-service-callable reverse
   * `userId -> Employee` lookup - `me { employee }` (GraphQL) is the
   * same lookup for a caller that can reach core's own BFF as itself;
   * this RPC is for a downstream service (mobile-ess-service,
   * attendance-leave-service, ...) that only has a JWT's `sub` claim and
   * needs the real `employeeId` it names, to verify a client-supplied
   * `employeeId` actually belongs to the calling session.
   */
  @GrpcMethod('EmployeeService', 'GetEmployeeIdForUser')
  async getEmployeeIdForUser(request: GetEmployeeIdForUserRequest): Promise<{ found: boolean; employeeId: string }> {
    return this.tenantContext.run({ tenantId: request.tenantId }, async () => {
      const employee = await this.employeesRepository.findByUserId(request.userId);
      if (!employee) {
        return { found: false, employeeId: '' };
      }
      return { found: true, employeeId: employee.id };
    });
  }
}
