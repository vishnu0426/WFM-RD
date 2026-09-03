import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { Role } from '../entities/role.entity';
import { RoleStatus } from '../entities/role-status.enum';
import { UserRole } from '../entities/user-role.entity';
import { User } from '../entities/user.entity';

export interface CreateRoleInput {
  name: string;
  description?: string | null;
  status?: RoleStatus;
  organizationId?: string | null;
  isDefault?: boolean;
}

export interface RoleUserRow {
  id: string;
  email: string;
  givenName: string | null;
  familyName: string | null;
  status: string;
  scopeOrgUnitId: string | null;
  scopeGroupId: string | null;
}

/**
 * Deliberately not a `TenantScopedRepository<Role>` subclass: `Role.tenantId`
 * is nullable (system roles, §2.1), so `Role` doesn't structurally satisfy
 * `TenantScopedRepository`'s `{ tenantId: string }` constraint. Every method
 * here still requires a bound tenant context and always writes/reads a
 * tenant-scoped (non-null `tenantId`) row - system-global roles are seed-only
 * data (`src/database/seeds/run-seed.ts`), never touched through this class.
 *
 * Phase 3's SCIM `/scim/v2/Groups` maps one SCIM Group to one tenant-scoped
 * `Role` by name (`ScimGroupsController`'s own doc comment).
 */
@Injectable()
export class RolesRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  async findByName(name: string): Promise<Role | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(Role).findOne({ where: { tenantId, name } }),
    );
  }

  async findById(id: string): Promise<Role | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(Role).findOne({ where: { tenantId, id } }),
    );
  }

  /**
   * Like `findById`, but also matches system roles (`tenantId IS NULL`) -
   * for resolving a role a user is actually *assigned*, which can
   * legitimately be a system role (`UserRole.roleId` isn't restricted to
   * tenant-scoped roles - seed data assigns `tenant_admin` itself this way).
   * `findById`'s tenant-only filter stays as-is for its other callers
   * (`RoleManagementService`'s tenant-admin CRUD, `ScimGroupsService`'s
   * group<->role mapping), where resolving to a system role would be wrong.
   */
  async findByIdIncludingSystem(id: string): Promise<Role | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager
        .getRepository(Role)
        .createQueryBuilder('role')
        .where('role.id = :id', { id })
        .andWhere('(role.tenant_id = :tenantId OR role.tenant_id IS NULL)', { tenantId })
        .getOne(),
    );
  }

  async findAllForTenant(): Promise<Role[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(Role).find({ where: { tenantId } }),
    );
  }

  /**
   * Tenant's own roles plus platform-shipped system roles (`tenantId IS
   * NULL`) - the `roles_read` RLS policy (Phase 1 migration) already treats
   * system roles as readable by every tenant; this is the first read path
   * that actually surfaces them, for admin-console visibility into which
   * roles (including system ones) are assignable, not just which ones a
   * tenant can edit.
   */
  async findAllIncludingSystem(): Promise<Role[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager
        .getRepository(Role)
        .createQueryBuilder('role')
        .where('role.tenant_id = :tenantId OR role.tenant_id IS NULL', { tenantId })
        .getMany(),
    );
  }

  async create(input: CreateRoleInput): Promise<Role> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(Role).save(
        manager.getRepository(Role).create({
          tenantId,
          name: input.name,
          isSystemRole: false,
          description: input.description ?? null,
          status: input.status ?? RoleStatus.ACTIVE,
          organizationId: input.organizationId ?? null,
          isDefault: input.isDefault ?? false,
        }),
      ),
    );
  }

  /** Replaces the old dead `rename(id, name)` - a general patch covering every tenant-editable field on `Role`. */
  async update(
    id: string,
    patch: Partial<Pick<Role, 'name' | 'description' | 'status' | 'organizationId' | 'isDefault'>>,
  ): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    await withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(Role).update({ tenantId, id }, patch),
    );
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    await withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(Role).delete({ tenantId, id }),
    );
  }

  /**
   * One row per (user, scopeOrgUnitId) assignment - a user holding `roleId`
   * in two different org-unit scopes appears twice, matching how
   * `UserRole` rows actually work (the frontend needs to show scope per
   * assignment row, not just per user, so this deliberately doesn't
   * de-duplicate by user the way `RoleManagementService.userIdsWithRole`
   * does for cache-invalidation purposes).
   */
  async findUsersWithRole(roleId: string): Promise<RoleUserRow[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager
        .getRepository(UserRole)
        .createQueryBuilder('user_role')
        .innerJoin(User, 'user', 'user.id = user_role.user_id')
        .where('user_role.tenant_id = :tenantId', { tenantId })
        .andWhere('user_role.role_id = :roleId', { roleId })
        .select('user.id', 'id')
        .addSelect('user.email', 'email')
        .addSelect('user.given_name', 'givenName')
        .addSelect('user.family_name', 'familyName')
        .addSelect('user.status', 'status')
        .addSelect('user_role.scope_org_unit_id', 'scopeOrgUnitId')
        .addSelect('user_role.scope_group_id', 'scopeGroupId')
        .getRawMany<RoleUserRow>(),
    );
  }
}
