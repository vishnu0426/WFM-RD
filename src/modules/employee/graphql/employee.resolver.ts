import { UseGuards } from '@nestjs/common';
import { Args, Context, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { EmployeeGraphQLType } from './employee.type';
import { Employee } from '../entities/employee.entity';
import { maskTaxId } from '../util/mask-tax-id';
import { EmployeeHistoryEntryType } from './employee-history-entry.type';
import { OrgUnitGraphQLType } from '../../org-unit/graphql/org-unit.type';
import { EmployeesRepository } from '../repositories/employees.repository';
import { EmployeeHistoryRepository } from '../repositories/employee-history.repository';
import { EmployeesService } from '../services/employees.service';
import { OrgUnitsService } from '../../org-unit/services/org-units.service';
import { CreateEmployeeInput } from '../dto/create-employee.input';
import { UpdateEmployeeInput } from '../dto/update-employee.input';
import { EmployeeFilterInput, PaginationInput } from '../dto/employee-filter.input';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';
import { AbacService } from '../../policy/services/abac.service';

/**
 * Gated for the first time here - this resolver previously had no
 * `@UseGuards`/`@RequirePermissions` at all (found while closing
 * ADR-0150's `userId -> Employee` gap: adding a `userId` link field to
 * `updateEmployee` without also gating the resolver would let any
 * authenticated caller re-link any employee to any user). Same
 * `@UseGuards(AccessTokenGuard, PermissionsGuard)` class-level + per-handler
 * `@RequirePermissions('resource:action')` pattern as `PolicyResolver`/
 * `UserResolver`. Requires the companion `employee:read`/`employee:write`
 * permission-catalog seed (`src/database/seeds/run-seed.ts`) - without it,
 * this locks out every existing caller including `tenant_admin`.
 *
 * GAP-06 fix (enterprise readiness audit, 2026-08-18): every mutation now
 * records an `audit_log` entry, same `AuditLogRepository.record(...)`
 * pattern `RoleManagementController`/`PolicyManagementController` already
 * use - employee mutations were a real, previously-undetected gap in audit
 * coverage (payroll/compliance-relevant changes with no trail).
 *
 * CRITICAL gap-fix (enterprise readiness audit): every method below now
 * also asserts/filters through `AbacService` in addition to the RBAC
 * `@RequirePermissions` check - the JWT-flattened RBAC check alone can only
 * answer "does this caller hold employee:read/write anywhere," never "for
 * *this* employee," so a role assignment scoped to one org unit or group
 * (User Access Rights' "Specific organization unit"/"Specific group"
 * radios) previously had no actual restricting effect on Employee access.
 * `employee`/`updateEmployee`/`transferEmployee` assert-or-throw
 * (`AbacScopeDeniedError`, 400); `employees()` filters its result set
 * in-memory instead, since a list query should show the scoped subset, not
 * fail outright; `createEmployee` checks the *destination* org unit (group
 * scope doesn't apply pre-creation - the employee has no group membership
 * yet).
 */
@Resolver(() => EmployeeGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeResolver {
  constructor(
    private readonly employeesRepository: EmployeesRepository,
    private readonly employeeHistoryRepository: EmployeeHistoryRepository,
    private readonly employeesService: EmployeesService,
    private readonly orgUnitsService: OrgUnitsService,
    private readonly auditLog: AuditLogRepository,
    private readonly abac: AbacService,
  ) {}

  @Query(() => EmployeeGraphQLType)
  @RequirePermissions('employee:read')
  async employee(
    @Context() context: { req: RequestWithTokenClaims },
    @Args('id', { type: () => ID }) id: string,
  ): Promise<EmployeeGraphQLType> {
    const employee = await this.employeesService.findById(id);
    await this.abac.assertPermittedForEmployee(context.req.tokenClaims!.sub, 'employee', 'read', employee);
    return employee;
  }

  @Query(() => [EmployeeGraphQLType])
  @RequirePermissions('employee:read')
  async employees(
    @Context() context: { req: RequestWithTokenClaims },
    @Args('filter', { type: () => EmployeeFilterInput, nullable: true }) filter: EmployeeFilterInput = {},
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput = {},
  ): Promise<EmployeeGraphQLType[]> {
    const results = await this.employeesService.findMany(filter, pagination);
    const scope = await this.abac.getEmployeeScopeFilter(context.req.tokenClaims!.sub, 'employee', 'read');
    if (scope.tenantWide) return results;
    const employeeIds = new Set(scope.employeeIdsInScopedGroups);
    const orgUnitIds = new Set(scope.orgUnitIds);
    return results.filter((e) => orgUnitIds.has(e.orgUnitId) || employeeIds.has(e.id));
  }

  /**
   * GAP-06 fix (User Management audit): `employees()` already took a real
   * `limit`/`offset`, but nothing told a caller how many pages existed. A
   * tenant-wide caller gets an efficient `COUNT(*)`; a scoped caller (a
   * supervisor restricted to an org unit or group) gets the size of the
   * same in-memory-filtered set `employees()` itself returns, since ABAC
   * scope isn't expressible as a SQL WHERE clause today - correct, not
   * fast, and the same tradeoff `employees()` already accepted for the
   * scoped case.
   */
  @Query(() => Number)
  @RequirePermissions('employee:read')
  async employeesCount(
    @Context() context: { req: RequestWithTokenClaims },
    @Args('filter', { type: () => EmployeeFilterInput, nullable: true }) filter: EmployeeFilterInput = {},
  ): Promise<number> {
    const scope = await this.abac.getEmployeeScopeFilter(context.req.tokenClaims!.sub, 'employee', 'read');
    if (scope.tenantWide) return this.employeesService.countMany(filter);
    const all = await this.employeesService.findMany(filter, { limit: 100000, offset: 0 });
    const employeeIds = new Set(scope.employeeIdsInScopedGroups);
    const orgUnitIds = new Set(scope.orgUnitIds);
    return all.filter((e) => orgUnitIds.has(e.orgUnitId) || employeeIds.has(e.id)).length;
  }

  /** §2.3's employee-side history read - full lineage, oldest first. */
  @Query(() => [EmployeeHistoryEntryType])
  @RequirePermissions('employee:read')
  async employeeHistory(
    @Context() context: { req: RequestWithTokenClaims },
    @Args('employeeId', { type: () => ID }) employeeId: string,
  ): Promise<EmployeeHistoryEntryType[]> {
    const employee = await this.employeesService.findById(employeeId);
    await this.abac.assertPermittedForEmployee(context.req.tokenClaims!.sub, 'employee', 'read', employee);
    return this.employeeHistoryRepository.findHistory(employeeId);
  }

  @Mutation(() => EmployeeGraphQLType)
  @RequirePermissions('employee:write')
  async createEmployee(
    @Context() context: { req: RequestWithTokenClaims },
    @Args('input') input: CreateEmployeeInput,
  ): Promise<EmployeeGraphQLType> {
    // Group scope doesn't apply here - a brand-new employee has no group
    // membership yet - so this checks the destination org unit only, via
    // the plain org-unit-only assertion rather than assertPermittedForEmployee
    // (which would need a real employee id for its group-membership subquery).
    await this.abac.assertPermittedForOrgUnit(context.req.tokenClaims!.sub, 'employee', 'write', input.orgUnitId);
    const employee = await this.employeesService.create(input);
    await this.audit(context, 'employee.created', employee.id, null, employee);
    return employee;
  }

  @Mutation(() => EmployeeGraphQLType)
  @RequirePermissions('employee:write')
  async updateEmployee(
    @Context() context: { req: RequestWithTokenClaims },
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateEmployeeInput,
  ): Promise<EmployeeGraphQLType> {
    const before = await this.employeesService.findById(id);
    await this.abac.assertPermittedForEmployee(context.req.tokenClaims!.sub, 'employee', 'write', before);
    const employee = await this.employeesService.update(id, input);
    await this.audit(context, 'employee.updated', id, before, employee);
    return employee;
  }

  @Mutation(() => EmployeeGraphQLType)
  @RequirePermissions('employee:write')
  async transferEmployee(
    @Context() context: { req: RequestWithTokenClaims },
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Args('newOrgUnitId', { type: () => ID }) newOrgUnitId: string,
    @Args('newManagerEmployeeId', { type: () => ID, nullable: true }) newManagerEmployeeId?: string,
    // GAP-07 fix (enterprise readiness audit, 2026-08-18): backdated/
    // future-dated transfer support - see `UpdateEmployeeInput.effectiveDate`'s
    // own doc comment.
    @Args('effectiveDate', { type: () => String, nullable: true }) effectiveDate?: string,
  ): Promise<EmployeeGraphQLType> {
    const before = await this.employeesService.findById(employeeId);
    await this.abac.assertPermittedForEmployee(context.req.tokenClaims!.sub, 'employee', 'write', before);
    const employee = await this.employeesService.transfer(
      employeeId,
      newOrgUnitId,
      newManagerEmployeeId ?? undefined,
      effectiveDate,
    );
    await this.audit(context, 'employee.transferred', employeeId, before, employee);
    return employee;
  }

  @ResolveField(() => OrgUnitGraphQLType, { name: 'orgUnit' })
  async resolveOrgUnit(@Parent() employee: EmployeeGraphQLType): Promise<OrgUnitGraphQLType> {
    return this.orgUnitsService.findById(employee.orgUnitId);
  }

  @ResolveField(() => EmployeeGraphQLType, { name: 'manager', nullable: true })
  async resolveManager(@Parent() employee: EmployeeGraphQLType): Promise<EmployeeGraphQLType | null> {
    if (!employee.managerEmployeeId) {
      return null;
    }
    return this.employeesRepository.findById(employee.managerEmployeeId);
  }

  @ResolveField(() => [EmployeeGraphQLType], { name: 'directReports' })
  async resolveDirectReports(@Parent() employee: EmployeeGraphQLType): Promise<EmployeeGraphQLType[]> {
    return this.employeesRepository.findDirectReports(employee.id);
  }

  @ResolveField(() => EmployeeGraphQLType, { name: 'teamLead', nullable: true })
  async resolveTeamLead(@Parent() employee: EmployeeGraphQLType): Promise<EmployeeGraphQLType | null> {
    const raw = employee as unknown as Employee;
    if (!raw.teamLeadEmployeeId) {
      return null;
    }
    return this.employeesRepository.findById(raw.teamLeadEmployeeId);
  }

  /** Masked to last 4 characters — `taxId` itself is deliberately never a `@Field` on `EmployeeGraphQLType`; see `GET /v1/employees/:id/tax-id` for the real value. */
  @ResolveField(() => String, { name: 'taxIdLastFour', nullable: true })
  resolveTaxIdLastFour(@Parent() employee: EmployeeGraphQLType): string | null {
    return maskTaxId((employee as unknown as Employee).taxId);
  }

  private async audit(
    context: { req: RequestWithTokenClaims },
    action: string,
    resourceId: string,
    beforeState: EmployeeGraphQLType | null,
    afterState: EmployeeGraphQLType | null,
  ): Promise<void> {
    const claims = context.req.tokenClaims!;
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action,
      resourceType: 'employee',
      resourceId,
      beforeState: beforeState as unknown as Record<string, unknown> | null,
      afterState: afterState as unknown as Record<string, unknown> | null,
      aiRationale: null,
    });
  }
}
