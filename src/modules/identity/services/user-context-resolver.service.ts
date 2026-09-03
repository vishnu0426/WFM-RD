import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';

export interface ResolvedUserContext {
  roles: string[];
  permissions: string[];
  orgUnitId: string | null;
}

interface RoleRow {
  role_id: string;
  scope_org_unit_id: string | null;
}

/**
 * The Postgres-backed read path behind `IdentityService.GetUserContext`
 * (§3.3) and `UserContextCacheService`'s cache-miss fallback. Joins
 * `user_roles` -> `roles` (names) and `user_roles` -> `role_permissions` ->
 * `permissions` (`"resource:action"` strings, §3.4's claim format) for one
 * user, within the caller's already-bound tenant context.
 *
 * `orgUnitId` projects §2.1's per-role ABAC scope (`user_roles.scope_org_unit_id`,
 * one row per role assignment) down to §3.4's single nullable JWT claim: if
 * every one of the user's role assignments shares the same scope (including
 * "all tenant-wide"), that value is used; a user with genuinely mixed scopes
 * (e.g. one tenant-wide role plus one role scoped to a specific org unit)
 * gets `null` rather than an arbitrary pick, since Phase 2 has no real ABAC
 * evaluator to resolve the ambiguity - that's Phase 4 scope (see
 * docs/phase-2-design-doc.md's explicit assumptions).
 */
@Injectable()
export class UserContextResolverService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  async resolve(userId: string): Promise<ResolvedUserContext> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const roleRows: RoleRow[] = await manager.query(
        `SELECT role_id, scope_org_unit_id FROM core.user_roles WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId],
      );
      const roleIds = [...new Set(roleRows.map((r) => r.role_id))];
      if (roleIds.length === 0) {
        return { roles: [], permissions: [], orgUnitId: null };
      }

      const [roleNameRows, permissionRows] = await Promise.all([
        manager.query<{ name: string }[]>(
          `SELECT name FROM core.roles WHERE id = ANY($1::uuid[]) AND (tenant_id = $2 OR tenant_id IS NULL)`,
          [roleIds, tenantId],
        ),
        manager.query<{ resource: string; action: string }[]>(
          `SELECT DISTINCT p.resource, p.action
           FROM core.role_permissions rp
           JOIN core.permissions p ON p.id = rp.permission_id
           WHERE rp.role_id = ANY($1::uuid[]) AND (rp.tenant_id = $2 OR rp.tenant_id IS NULL)`,
          [roleIds, tenantId],
        ),
      ]);

      const distinctScopes = new Set(roleRows.map((r) => r.scope_org_unit_id ?? '__tenant_wide__'));
      const orgUnitId = distinctScopes.size === 1 ? (roleRows[0].scope_org_unit_id ?? null) : null;

      return {
        roles: roleNameRows.map((r) => r.name),
        permissions: permissionRows.map((p) => `${p.resource}:${p.action}`),
        orgUnitId,
      };
    });
  }
}
