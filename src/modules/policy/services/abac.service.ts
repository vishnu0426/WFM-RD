import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { AbacScopeDeniedError } from '../errors/abac-scope-denied.error';

/**
 * §3.1's ABAC requirement, e.g. "Site Supervisor scoped to their org-unit
 * subtree." `PermissionsGuard` (RBAC) checks the JWT's flattened
 * `permissions` claim - true regardless of which role assignment granted
 * it, or what `scope_org_unit_id` that assignment carried (§3.4's claim
 * shape has no room for per-permission scope). This service does the fresh
 * Postgres lookup that distinction actually requires, for endpoints acting
 * on one specific org-unit-scoped resource (Phase 4 wires this into
 * `PolicyManagementController` for `Policy.orgUnitId`-scoped policies).
 *
 * **Exact-org-unit-match only, not subtree-aware.** A role scoped to org
 * unit X grants access to resources scoped to exactly X, not to X's
 * descendants - true subtree evaluation needs Module 02's `path` ltree
 * hierarchy (`OrgUnitsRepository.findSubtree`), which Module 01 does not
 * query directly (no cross-module FK/table access by bounded-context
 * design, §2.1's own `scope_org_unit_id` doc comment). Extending this to
 * subtree-aware evaluation needs a cross-module gRPC call Module 02 does
 * not yet expose - flagged in the production readiness checklist, not
 * silently approximated.
 *
 * `isPermittedForGroup` is the same evaluation against the other scope
 * axis (`scope_group_id`, UserRole group-scope gap-fix). Both methods
 * require the *other* axis to be NULL on the candidate row - a grant
 * scoped to org unit X must never satisfy a group-scoped check just
 * because `scope_group_id IS NULL` on that row, and vice versa - matching
 * the DB's own mutual-exclusivity CHECK constraint on `user_roles`.
 */
@Injectable()
export class AbacService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  async isPermittedForOrgUnit(
    userId: string,
    resource: string,
    action: string,
    targetOrgUnitId: string | null,
  ): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const rows = await manager.query(
        `SELECT 1
         FROM core.user_roles ur
         JOIN core.role_permissions rp ON rp.role_id = ur.role_id
         JOIN core.permissions p ON p.id = rp.permission_id
         WHERE ur.tenant_id = $1 AND ur.user_id = $2
           AND p.resource = $3 AND p.action = $4
           AND ((ur.scope_org_unit_id IS NULL AND ur.scope_group_id IS NULL) OR ur.scope_org_unit_id = $5)
         LIMIT 1`,
        [tenantId, userId, resource, action, targetOrgUnitId],
      );
      return rows.length > 0;
    });
  }

  async assertPermittedForOrgUnit(
    userId: string,
    resource: string,
    action: string,
    targetOrgUnitId: string | null,
  ): Promise<void> {
    const permitted = await this.isPermittedForOrgUnit(userId, resource, action, targetOrgUnitId);
    if (!permitted) {
      throw new AbacScopeDeniedError(resource, action, targetOrgUnitId);
    }
  }

  async isPermittedForGroup(
    userId: string,
    resource: string,
    action: string,
    targetGroupId: string | null,
  ): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const rows = await manager.query(
        `SELECT 1
         FROM core.user_roles ur
         JOIN core.role_permissions rp ON rp.role_id = ur.role_id
         JOIN core.permissions p ON p.id = rp.permission_id
         WHERE ur.tenant_id = $1 AND ur.user_id = $2
           AND p.resource = $3 AND p.action = $4
           AND ((ur.scope_org_unit_id IS NULL AND ur.scope_group_id IS NULL) OR ur.scope_group_id = $5)
         LIMIT 1`,
        [tenantId, userId, resource, action, targetGroupId],
      );
      return rows.length > 0;
    });
  }

  async assertPermittedForGroup(
    userId: string,
    resource: string,
    action: string,
    targetGroupId: string | null,
  ): Promise<void> {
    const permitted = await this.isPermittedForGroup(userId, resource, action, targetGroupId);
    if (!permitted) {
      throw new AbacScopeDeniedError(resource, action, targetGroupId, 'group');
    }
  }

  /**
   * Enterprise readiness audit gap-fix (CRITICAL): a role assignment scoped
   * to a specific org unit or a specific Employee Group was previously
   * stored (`user_roles.scope_org_unit_id`/`scope_group_id`) but never
   * consulted for `Employee` access - `EmployeeResolver`'s guards only
   * checked the flat RBAC permission (`employee:write` present anywhere
   * across the caller's roles), so a supervisor scoped to one org unit
   * could in practice read/write every employee in the tenant. This is the
   * single combined check a real employee-record operation needs: tenant-
   * wide (both scope columns null) OR the row's org-unit scope matches this
   * employee's actual org unit OR the row's group scope matches a group
   * this employee is actually a member of.
   *
   * The group-membership half is a direct `org.employee_group_members`
   * subquery rather than injecting `EmployeeGroupMembersRepository` -
   * `EmployeeGroupModule` already has a one-directional dependency on
   * `EmployeeModule` (`addMember` needs `EmployeesService`), so a `Employee
   * -> PolicyModule -> EmployeeGroupModule -> EmployeeModule` provider
   * chain would close that into a cycle. Same "opaque cross-module
   * reference, plain SQL instead of a service call" convention this file's
   * own `scope_org_unit_id`/`scope_group_id` handling already uses.
   */
  async isPermittedForEmployee(
    userId: string,
    resource: string,
    action: string,
    targetEmployee: { id: string; orgUnitId: string },
  ): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const rows = await manager.query(
        `SELECT 1
         FROM core.user_roles ur
         JOIN core.role_permissions rp ON rp.role_id = ur.role_id
         JOIN core.permissions p ON p.id = rp.permission_id
         WHERE ur.tenant_id = $1 AND ur.user_id = $2
           AND p.resource = $3 AND p.action = $4
           AND (
             (ur.scope_org_unit_id IS NULL AND ur.scope_group_id IS NULL)
             OR ur.scope_org_unit_id = $5
             OR (
               ur.scope_group_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM org.employee_group_members egm
                 WHERE egm.tenant_id = ur.tenant_id AND egm.group_id = ur.scope_group_id AND egm.employee_id = $6
               )
             )
           )
         LIMIT 1`,
        [tenantId, userId, resource, action, targetEmployee.orgUnitId, targetEmployee.id],
      );
      return rows.length > 0;
    });
  }

  async assertPermittedForEmployee(
    userId: string,
    resource: string,
    action: string,
    targetEmployee: { id: string; orgUnitId: string },
  ): Promise<void> {
    const permitted = await this.isPermittedForEmployee(userId, resource, action, targetEmployee);
    if (!permitted) {
      throw new AbacScopeDeniedError(resource, action, targetEmployee.id, 'employee');
    }
  }

  /**
   * The list-query counterpart to `isPermittedForEmployee`: `employees()`
   * can't assert-or-reject the way a single-record read/write can - a
   * scoped caller should just see the subset their scope actually covers,
   * not an error. Returns enough for the caller to filter an already-
   * fetched `Employee[]` in memory: `tenantWide` short-circuits (show
   * everything), otherwise `orgUnitIds`/`employeeIdsInScopedGroups` are the
   * two allow-lists to OR together.
   */
  async getEmployeeScopeFilter(
    userId: string,
    resource: string,
    action: string,
  ): Promise<{ tenantWide: boolean; orgUnitIds: string[]; employeeIdsInScopedGroups: string[] }> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const scopeRows: { scope_org_unit_id: string | null; scope_group_id: string | null }[] = await manager.query(
        `SELECT ur.scope_org_unit_id, ur.scope_group_id
         FROM core.user_roles ur
         JOIN core.role_permissions rp ON rp.role_id = ur.role_id
         JOIN core.permissions p ON p.id = rp.permission_id
         WHERE ur.tenant_id = $1 AND ur.user_id = $2 AND p.resource = $3 AND p.action = $4`,
        [tenantId, userId, resource, action],
      );
      const tenantWide = scopeRows.some((r) => r.scope_org_unit_id === null && r.scope_group_id === null);
      const orgUnitIds = [...new Set(scopeRows.map((r) => r.scope_org_unit_id).filter((v): v is string => v !== null))];
      const groupIds = [...new Set(scopeRows.map((r) => r.scope_group_id).filter((v): v is string => v !== null))];
      if (tenantWide || groupIds.length === 0) {
        return { tenantWide, orgUnitIds, employeeIdsInScopedGroups: [] };
      }
      const memberRows: { employee_id: string }[] = await manager.query(
        `SELECT DISTINCT employee_id FROM org.employee_group_members WHERE tenant_id = $1 AND group_id = ANY($2::uuid[])`,
        [tenantId, groupIds],
      );
      return { tenantWide, orgUnitIds, employeeIdsInScopedGroups: memberRows.map((r) => r.employee_id) };
    });
  }
}
