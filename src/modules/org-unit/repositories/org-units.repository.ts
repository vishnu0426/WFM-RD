import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { OrgUnit } from '../entities/org-unit.entity';

@Injectable()
export class OrgUnitsRepository extends TenantScopedRepository<OrgUnit> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, OrgUnit, tenantContext);
  }

  async findById(id: string): Promise<OrgUnit | null> {
    return this.findOne({ where: { id } as never });
  }

  async findRoots(): Promise<OrgUnit[]> {
    return this.find({ where: { parentOrgUnitId: IsNull() } as never });
  }

  async findDirectChildren(parentOrgUnitId: string): Promise<OrgUnit[]> {
    return this.find({ where: { parentOrgUnitId } as never });
  }

  /**
   * `effectiveAt` (GAP-07 fix, enterprise readiness audit, 2026-08-18):
   * when supplied, binds the session-local `app.effective_at` GUC for the
   * duration of this transaction so `org.fn_org_unit_history_track()`
   * versions the resulting `OrgUnitHistory` row as of that timestamp
   * instead of `now()` - see `1700000017000`'s own doc comment. Omitted
   * (the default) means "effective now," unchanged - same shape as
   * `EmployeesRepository.updateWithOutboxEvent`'s own `effectiveAt` param.
   */
  async updateWithEffectiveDate(id: string, partial: Partial<OrgUnit>, effectiveAt?: Date): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    await withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, async (manager) => {
      if (effectiveAt) {
        await manager.query('SELECT set_config($1, $2, true)', ['app.effective_at', effectiveAt.toISOString()]);
      }
      await manager.getRepository(OrgUnit).update({ id, tenantId }, partial as never);
    });
  }

  /**
   * Current-state subtree read (includes `rootId` itself), backed by the
   * `path ltree` GiST index (ADR-0008) - the query Scheduling's
   * `GetSchedulableEmployees` hot path (§0.5 SLO) ultimately depends on.
   * `path` isn't a mapped TypeORM column (see the entity's doc comment), so
   * the containment predicate is raw SQL; the projected columns still come
   * from the entity's normal metadata via `getMany()`.
   */
  async findSubtree(rootId: string): Promise<OrgUnit[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager
        .getRepository(OrgUnit)
        .createQueryBuilder('org_unit')
        .where('org_unit.tenant_id = :tenantId', { tenantId })
        .andWhere('org_unit.path <@ (SELECT path FROM org.org_units WHERE id = :rootId AND tenant_id = :tenantId)', {
          rootId,
          tenantId,
        })
        .getMany(),
    );
  }
}
