import { UseGuards } from '@nestjs/common';
import { Args, Context, ID, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { UserGraphQLType } from './user.type';
import { RoleGraphQLType } from './role.type';
import { OrgUnitScopeGraphQLType } from './org-unit-scope.type';
import { UsersRepository } from '../repositories/users.repository';
import { UserRolesRepository } from '../repositories/user-roles.repository';
import { RolesRepository } from '../repositories/roles.repository';
import { Role } from '../entities/role.entity';
import { UserNotFoundError } from '../errors/user-not-found.error';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { EmployeesRepository } from '../../employee/repositories/employees.repository';
import { EmployeeGraphQLType } from '../../employee/graphql/employee.type';
import { OrgUnitsRepository } from '../../org-unit/repositories/org-units.repository';
import type { OrgUnit } from '../../org-unit/entities/org-unit.entity';

/**
 * Phase 6 GraphQL BFF (ADR-0045) - read-only. `me` deliberately needs no
 * `@RequirePermissions`: any authenticated user may read their own record,
 * the same posture `GET /webauthn/credentials` already takes (an
 * `AccessTokenGuard`-only endpoint, no RBAC check, because "my own data" is
 * not a permission-gated concern).
 */
@Resolver(() => UserGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class UserResolver {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly userRolesRepository: UserRolesRepository,
    private readonly rolesRepository: RolesRepository,
    private readonly employeesRepository: EmployeesRepository,
    private readonly orgUnitsRepository: OrgUnitsRepository,
  ) {}

  @Query(() => UserGraphQLType)
  async me(@Context() context: { req: RequestWithTokenClaims }): Promise<UserGraphQLType> {
    const claims = context.req.tokenClaims!;
    const user = await this.usersRepository.findOne({ where: { id: claims.sub } as never });
    if (!user) {
      throw new UserNotFoundError(claims.sub);
    }
    return user;
  }

  @Query(() => UserGraphQLType)
  @RequirePermissions('user:read')
  async user(@Args('id', { type: () => ID }) id: string): Promise<UserGraphQLType> {
    const user = await this.usersRepository.findOne({ where: { id } as never });
    if (!user) {
      throw new UserNotFoundError(id);
    }
    return user;
  }

  @Query(() => [UserGraphQLType])
  @RequirePermissions('user:read')
  async users(): Promise<UserGraphQLType[]> {
    return this.usersRepository.find();
  }

  @ResolveField(() => [RoleGraphQLType], { name: 'roles' })
  async resolveRoles(@Parent() user: UserGraphQLType): Promise<RoleGraphQLType[]> {
    const assignments = await this.userRolesRepository.findForUser(user.id);
    // findByIdIncludingSystem, not findById: a user's assignment can point at
    // a system role (tenantId IS NULL - e.g. every seeded tenant_admin grant),
    // which findById's tenant-only filter would silently drop, making every
    // such user appear to have no roles at all.
    const roles = await Promise.all(assignments.map((a) => this.rolesRepository.findByIdIncludingSystem(a.roleId)));
    return roles.filter((r): r is Role => r !== null);
  }

  /**
   * Frontend Phase 0 foundation: resolves ABAC scope from the same
   * `UserRole` assignments `resolveRoles` above already reads (`scopeOrgUnitId:
   * null` = tenant-wide grant, a real org unit id = ABAC-scoped - §2.1) into
   * a shape a client-side org-unit picker can consume directly. See
   * `OrgUnitScopeGraphQLType`'s own doc comment for why this is visibility,
   * not new enforcement.
   *
   * UserRole group-scope gap-fix: `scopeOrgUnitId` and `scopeGroupId` are
   * mutually exclusive, so a group-scoped assignment also has
   * `scopeOrgUnitId: null` - checking that alone would misreport a
   * group-scoped grant as tenant-wide. `isTenantWide` now requires *both*
   * scope columns null.
   */
  @ResolveField(() => OrgUnitScopeGraphQLType, { name: 'orgUnitScope' })
  async resolveOrgUnitScope(@Parent() user: UserGraphQLType): Promise<OrgUnitScopeGraphQLType> {
    const assignments = await this.userRolesRepository.findForUser(user.id);
    const isTenantWide = assignments.some((a) => a.scopeOrgUnitId === null && a.scopeGroupId === null);
    const scopedIds = [...new Set(assignments.map((a) => a.scopeOrgUnitId).filter((id): id is string => id !== null))];
    const orgUnits = await Promise.all(scopedIds.map((id) => this.orgUnitsRepository.findById(id)));
    return { isTenantWide, orgUnits: orgUnits.filter((o): o is OrgUnit => o !== null) };
  }

  /**
   * Closes ADR-0150's `userId -> Employee` gap: the concrete deliverable
   * is that any authenticated client can now ask `me { employee { id
   * employeeNumber orgUnitId } }` and get a real answer. `null` for a
   * user with no linked employee (headcount-only employees exist, but so
   * does the more common case today - most `User` rows have no
   * `Employee` pointing back at them yet, since nothing populated the
   * link before this phase) - same "my own data, no extra permission
   * needed" posture `me` itself already has.
   */
  @ResolveField(() => EmployeeGraphQLType, { name: 'employee', nullable: true })
  async resolveEmployee(@Parent() user: UserGraphQLType): Promise<EmployeeGraphQLType | null> {
    return this.employeesRepository.findByUserId(user.id);
  }
}
