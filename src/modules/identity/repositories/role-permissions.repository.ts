import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { RolePermission } from '../entities/role-permission.entity';
import { Permission } from '../entities/permission.entity';

/**
 * Deliberately not a `TenantScopedRepository` subclass: `role_permissions.tenant_id`
 * is trigger-synced from the parent role (ADR-0004), including `NULL` for
 * system-global roles - a shape `TenantScopedRepository`'s `{tenantId: string}`
 * constraint can't express (same reason `RolesRepository` isn't one either).
 * `core.fn_sync_tenant_id_from_role`'s trigger, combined with the
 * `role_permissions_insert` RLS policy's `WITH CHECK (tenant_id = current_tenant)`,
 * means binding a permission to a *system* role through this class (or any
 * `agno_app`-credentialed path) is already impossible at the database level
 * - only `agno_migrator` (the seed script) can do that. Every method here
 * therefore only ever succeeds against a tenant-scoped role.
 */
@Injectable()
export class RolePermissionsRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  async findForRole(roleId: string): Promise<Permission[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager
        .getRepository(Permission)
        .createQueryBuilder('permission')
        .innerJoin(RolePermission, 'rp', 'rp.permission_id = permission.id')
        .where('rp.role_id = :roleId', { roleId })
        .orderBy('permission.resource', 'ASC')
        .addOrderBy('permission.action', 'ASC')
        .getMany(),
    );
  }

  async bind(roleId: string, permissionId: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    await withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager
        .getRepository(RolePermission)
        .save(manager.getRepository(RolePermission).create({ roleId, permissionId })),
    );
  }

  async unbind(roleId: string, permissionId: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    await withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(RolePermission).delete({ roleId, permissionId }),
    );
  }
}
