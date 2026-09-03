import { UseGuards } from '@nestjs/common';
import {
  Args,
  Context,
  GraphQLISODateTime,
  ID,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { OrgUnitGraphQLType } from './org-unit.type';
import { OrgUnitSnapshotType } from './org-unit-snapshot.type';
import { EmployeeGraphQLType } from '../../employee/graphql/employee.type';
import { OrgUnitsService } from '../services/org-units.service';
import { OrgHierarchyService } from '../services/org-hierarchy.service';
import { OrgUnitsRepository } from '../repositories/org-units.repository';
import { EmployeesRepository } from '../../employee/repositories/employees.repository';
import { CreateOrgUnitInput } from '../dto/create-org-unit.input';
import { UpdateOrgUnitInput } from '../dto/update-org-unit.input';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * Gated for the first time here (frontend Phase 1 prerequisite): this
 * resolver had no `@UseGuards`/`@RequirePermissions` at all — any
 * authenticated caller could read or write org structure. Reuses the
 * `employee` resource/permission (not a new `org_unit` one) since org units
 * are intrinsically part of the employee/org domain and `employee:read`/
 * `employee:write` are already seeded and already granted to `tenant_admin`
 * — same reasoning `TenantIdentityProvidersController` used for reusing the
 * `tenant` resource rather than inventing a new one.
 *
 * GAP-06 fix (enterprise readiness audit, 2026-08-18): `createOrgUnit`/
 * `updateOrgUnit` now record an `audit_log` entry, same
 * `AuditLogRepository.record(...)` pattern `RoleManagementController`/
 * `PolicyManagementController` already use - org restructuring (rename,
 * reparent, status change) had no audit trail at all.
 */
@Resolver(() => OrgUnitGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class OrgUnitResolver {
  constructor(
    private readonly orgUnitsService: OrgUnitsService,
    private readonly orgHierarchyService: OrgHierarchyService,
    private readonly orgUnitsRepository: OrgUnitsRepository,
    private readonly employeesRepository: EmployeesRepository,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Query(() => OrgUnitGraphQLType)
  @RequirePermissions('employee:read')
  async orgUnit(@Args('id', { type: () => ID }) id: string): Promise<OrgUnitGraphQLType> {
    return this.orgUnitsService.findById(id);
  }

  /**
   * Frontend Phase 1 addition: `orgHierarchy`/`GET /v1/org-units/{id}/tree`
   * both require a `rootId` the caller must already know - nothing exposed
   * a way to discover one. `OrgUnitsRepository.findRoots()` already existed
   * (used internally), just never surfaced as a query. Needed for the org
   * chart page to have anything to render on first load.
   */
  @Query(() => [OrgUnitGraphQLType])
  @RequirePermissions('employee:read')
  async orgUnitRoots(): Promise<OrgUnitGraphQLType[]> {
    return this.orgUnitsRepository.findRoots();
  }

  /**
   * §2.3/§3.1: "show me the org chart as of March 1st." `asOfDate` omitted
   * = current tree. See `OrgHierarchyService` for the as-of/current split.
   */
  @Query(() => OrgUnitSnapshotType)
  @RequirePermissions('employee:read')
  async orgHierarchy(
    @Args('rootId', { type: () => ID }) rootId: string,
    @Args('asOfDate', { type: () => GraphQLISODateTime, nullable: true }) asOfDate?: Date,
  ): Promise<OrgUnitSnapshotType> {
    return this.orgHierarchyService.getHierarchy(rootId, asOfDate);
  }

  @Mutation(() => OrgUnitGraphQLType)
  @RequirePermissions('employee:write')
  async createOrgUnit(
    @Context() context: { req: RequestWithTokenClaims },
    @Args('input') input: CreateOrgUnitInput,
  ): Promise<OrgUnitGraphQLType> {
    const orgUnit = await this.orgUnitsService.create(input);
    await this.audit(context, 'org_unit.created', orgUnit.id, null, orgUnit);
    return orgUnit;
  }

  @Mutation(() => OrgUnitGraphQLType)
  @RequirePermissions('employee:write')
  async updateOrgUnit(
    @Context() context: { req: RequestWithTokenClaims },
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateOrgUnitInput,
  ): Promise<OrgUnitGraphQLType> {
    const before = await this.orgUnitsService.findById(id);
    const orgUnit = await this.orgUnitsService.update(id, input);
    await this.audit(context, 'org_unit.updated', id, before, orgUnit);
    return orgUnit;
  }

  @ResolveField(() => OrgUnitGraphQLType, { name: 'parent', nullable: true })
  async resolveParent(@Parent() orgUnit: OrgUnitGraphQLType): Promise<OrgUnitGraphQLType | null> {
    if (!orgUnit.parentOrgUnitId) {
      return null;
    }
    return this.orgUnitsRepository.findById(orgUnit.parentOrgUnitId);
  }

  @ResolveField(() => [OrgUnitGraphQLType], { name: 'children' })
  async resolveChildren(@Parent() orgUnit: OrgUnitGraphQLType): Promise<OrgUnitGraphQLType[]> {
    return this.orgUnitsRepository.findDirectChildren(orgUnit.id);
  }

  @ResolveField(() => [EmployeeGraphQLType], { name: 'employees' })
  async resolveEmployees(@Parent() orgUnit: OrgUnitGraphQLType): Promise<EmployeeGraphQLType[]> {
    return this.employeesRepository.findByOrgUnit(orgUnit.id);
  }

  private async audit(
    context: { req: RequestWithTokenClaims },
    action: string,
    resourceId: string,
    beforeState: OrgUnitGraphQLType | null,
    afterState: OrgUnitGraphQLType | null,
  ): Promise<void> {
    const claims = context.req.tokenClaims!;
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action,
      resourceType: 'org_unit',
      resourceId,
      beforeState: beforeState as unknown as Record<string, unknown> | null,
      afterState: afterState as unknown as Record<string, unknown> | null,
      aiRationale: null,
    });
  }
}
