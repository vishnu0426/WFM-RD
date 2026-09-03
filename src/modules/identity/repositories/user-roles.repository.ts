import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { UserRole } from '../entities/user-role.entity';

@Injectable()
export class UserRolesRepository extends TenantScopedRepository<UserRole> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, UserRole, tenantContext);
  }

  async findForUser(userId: string): Promise<UserRole[]> {
    return this.find({ where: { userId } as never });
  }

  /**
   * Tenant-wide assignments only (`scopeOrgUnitId IS NULL AND scopeGroupId
   * IS NULL`) - matches how `ScimGroupsService` maps a SCIM Group to a
   * Role. Both columns, not just `scopeOrgUnitId`: since the UserRole
   * group-scope gap-fix, a group-scoped assignment also has
   * `scopeOrgUnitId: null`, and SCIM's own doc comment already disclaims
   * that this mapping can't express *any* scoped assignment.
   */
  async findTenantWideForRole(roleId: string): Promise<UserRole[]> {
    return this.find({ where: { roleId, scopeOrgUnitId: null, scopeGroupId: null } as never });
  }

  async addMember(userId: string, roleId: string): Promise<UserRole> {
    return this.save({ userId, roleId, scopeOrgUnitId: null } as never);
  }

  async removeMember(userId: string, roleId: string): Promise<void> {
    await this.delete({ userId, roleId, scopeOrgUnitId: null } as never);
  }

  /**
   * Phase 4's general RBAC/ABAC assignment (`POST /v1/users/{id}/roles`) -
   * `scopeOrgUnitId`/`scopeGroupId` both null for a tenant-wide grant, or
   * exactly one set for an ABAC-scoped grant (§2.1; mutual exclusivity
   * validated by `RoleManagementService.assignRole` and enforced by a DB
   * CHECK constraint). `AbacService` is what actually interprets these at
   * authorization time; this repository just stores the assignment.
   */
  async assign(
    userId: string,
    roleId: string,
    scopeOrgUnitId: string | null,
    scopeGroupId: string | null = null,
  ): Promise<UserRole> {
    return this.save({ userId, roleId, scopeOrgUnitId, scopeGroupId } as never);
  }

  async revoke(
    userId: string,
    roleId: string,
    scopeOrgUnitId: string | null,
    scopeGroupId: string | null = null,
  ): Promise<void> {
    await this.delete({ userId, roleId, scopeOrgUnitId, scopeGroupId } as never);
  }
}
