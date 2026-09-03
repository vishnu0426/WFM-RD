import { Injectable } from '@nestjs/common';
import { RolesRepository, CreateRoleInput, RoleUserRow } from '../repositories/roles.repository';
import { RolePermissionsRepository } from '../repositories/role-permissions.repository';
import { PermissionsRepository } from '../repositories/permissions.repository';
import { UserRolesRepository } from '../repositories/user-roles.repository';
import { Role } from '../entities/role.entity';
import { Permission } from '../entities/permission.entity';
import { UserRole } from '../entities/user-role.entity';
import { RoleNotFoundError } from '../errors/role-not-found.error';
import { SystemRoleImmutableError } from '../errors/system-role-immutable.error';
import { InvalidRoleScopeError } from '../errors/invalid-role-scope.error';

export type UpdateRoleInput = Partial<CreateRoleInput>;

/**
 * §4's RBAC/ABAC management surface (`/v1/roles`, `/v1/permissions`,
 * `/v1/users/{id}/roles` - `IdentityApiModule`). Pure business logic, no
 * `AuthModule` dependency (see `IdentityApiModule`'s own doc comment for
 * why) - `UserContextCacheService` invalidation on a mutation that changes
 * a live user's effective permissions is the controller's job, since that
 * cache lives in `AuthModule`.
 */
@Injectable()
export class RoleManagementService {
  constructor(
    private readonly rolesRepository: RolesRepository,
    private readonly rolePermissionsRepository: RolePermissionsRepository,
    private readonly permissionsRepository: PermissionsRepository,
    private readonly userRolesRepository: UserRolesRepository,
  ) {}

  async listRoles(): Promise<Role[]> {
    return this.rolesRepository.findAllIncludingSystem();
  }

  async getRoleOrFail(id: string): Promise<Role> {
    const role = await this.rolesRepository.findById(id);
    if (!role) {
      throw new RoleNotFoundError(id);
    }
    return role;
  }

  /** Read-only variant of `getRoleOrFail` that also resolves system roles - for the GET paths (`getRole`, `listPermissionsForRole`), not the tenant-only mutation paths below. */
  async getRoleOrFailIncludingSystem(id: string): Promise<Role> {
    const role = await this.rolesRepository.findByIdIncludingSystem(id);
    if (!role) {
      throw new RoleNotFoundError(id);
    }
    return role;
  }

  async createRole(input: CreateRoleInput): Promise<Role> {
    return this.rolesRepository.create(input);
  }

  /**
   * `getRoleOrFail` (tenant-only) not `...IncludingSystem`: a system role
   * (`isSystemRole`) is seed-only data (`RolesRepository`'s own doc
   * comment) and can never be edited through this tenant-admin surface -
   * `SystemRoleImmutableError` below is the explicit rejection for that
   * case, not a silent 404.
   */
  async updateRole(id: string, patch: UpdateRoleInput): Promise<Role> {
    const role = await this.getRoleOrFail(id);
    if (role.isSystemRole) {
      throw new SystemRoleImmutableError(id);
    }
    await this.rolesRepository.update(id, patch);
    return this.getRoleOrFailIncludingSystem(id);
  }

  /** Viewing a system role's members works, matching `getRoleUserCount`'s existing use of `getRoleOrFailIncludingSystem`. */
  async usersWithRole(roleId: string): Promise<RoleUserRow[]> {
    await this.getRoleOrFailIncludingSystem(roleId);
    return this.rolesRepository.findUsersWithRole(roleId);
  }

  async deleteRole(id: string): Promise<void> {
    await this.getRoleOrFail(id);
    await this.rolesRepository.delete(id);
  }

  async listPermissions(): Promise<Permission[]> {
    return this.permissionsRepository.findAll();
  }

  async listPermissionsForRole(roleId: string): Promise<Permission[]> {
    await this.getRoleOrFailIncludingSystem(roleId);
    return this.rolePermissionsRepository.findForRole(roleId);
  }

  async bindPermission(roleId: string, permissionId: string): Promise<void> {
    await this.getRoleOrFail(roleId);
    await this.rolePermissionsRepository.bind(roleId, permissionId);
  }

  async unbindPermission(roleId: string, permissionId: string): Promise<void> {
    await this.rolePermissionsRepository.unbind(roleId, permissionId);
  }

  /** Every user currently holding `roleId` - `IdentityApiModule` uses this to invalidate their cached UserContext after a permission binding changes. */
  async userIdsWithRole(roleId: string): Promise<string[]> {
    const assignments = await this.userRolesRepository.find({ where: { roleId } as never });
    return [...new Set(assignments.map((a) => a.userId))];
  }

  async listRoleAssignments(userId: string): Promise<UserRole[]> {
    return this.userRolesRepository.findForUser(userId);
  }

  /**
   * `getRoleOrFailIncludingSystem`, not `getRoleOrFail`: granting a system
   * role (`platform_admin`/`tenant_admin`/`employee`) through this path is
   * a deliberate, requested behavior change - it used to 404 (tenant-only
   * lookup) even though `UserRole.roleId` was never actually restricted to
   * tenant-scoped roles (seed data itself assigns `tenant_admin` this way -
   * see `findByIdIncludingSystem`'s own doc comment).
   */
  async assignRole(
    userId: string,
    roleId: string,
    scopeOrgUnitId: string | null,
    scopeGroupId: string | null = null,
  ): Promise<UserRole> {
    if (scopeOrgUnitId && scopeGroupId) {
      throw new InvalidRoleScopeError();
    }
    await this.getRoleOrFailIncludingSystem(roleId);
    return this.userRolesRepository.assign(userId, roleId, scopeOrgUnitId, scopeGroupId);
  }

  async revokeRole(
    userId: string,
    roleId: string,
    scopeOrgUnitId: string | null,
    scopeGroupId: string | null = null,
  ): Promise<void> {
    await this.userRolesRepository.revoke(userId, roleId, scopeOrgUnitId, scopeGroupId);
  }
}
