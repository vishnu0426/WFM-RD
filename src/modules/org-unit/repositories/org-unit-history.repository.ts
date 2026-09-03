import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { OrgUnitHistory } from '../entities/org-unit-history.entity';

/**
 * Read-only, matching the trigger-only write path (see the entity's doc
 * comment) - deliberately not a `TenantScopedRepository` subclass, same
 * posture as `AuditLogRepository`.
 */
@Injectable()
export class OrgUnitHistoryRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  private withScope<R>(work: Parameters<typeof withTenantTransaction<R>>[2]): Promise<R> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, work);
  }

  /** Full version lineage for one org unit, oldest first. */
  async findHistory(orgUnitId: string): Promise<OrgUnitHistory[]> {
    return this.withScope((manager) =>
      manager
        .getRepository(OrgUnitHistory)
        .find({ where: { orgUnitId } as never, order: { validFrom: 'ASC' } as never }),
    );
  }

  /** The version that was active at `asOf` (the data-layer primitive behind `orgHierarchy(rootId, asOfDate)`, Phase 2). */
  async findVersionAsOf(orgUnitId: string, asOf: Date): Promise<OrgUnitHistory | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.withScope((manager) =>
      manager
        .getRepository(OrgUnitHistory)
        .createQueryBuilder('h')
        .where('h.tenant_id = :tenantId', { tenantId })
        .andWhere('h.org_unit_id = :orgUnitId', { orgUnitId })
        .andWhere('h.valid_from <= :asOf', { asOf })
        .andWhere('(h.valid_to IS NULL OR h.valid_to > :asOf)', { asOf })
        .getOne(),
    );
  }

  /**
   * Every org unit's version active at `asOf`, tenant-wide - one row per org
   * unit (a partial unique index guarantees at most one open version each).
   * `OrgHierarchyService` (Phase 2) walks this set in memory via
   * `parentOrgUnitId` to reconstruct a past tree, rather than a recursive
   * SQL CTE - see ADR-0013: this mirrors ADR-0007's precedent for BPO tenant
   * hierarchy traversal, and org-unit counts per tenant are orders of
   * magnitude below the 10M-employee scale this module partitions for.
   */
  async findAllAsOf(asOf: Date): Promise<OrgUnitHistory[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.withScope((manager) =>
      manager
        .getRepository(OrgUnitHistory)
        .createQueryBuilder('h')
        .where('h.tenant_id = :tenantId', { tenantId })
        .andWhere('h.valid_from <= :asOf', { asOf })
        .andWhere('(h.valid_to IS NULL OR h.valid_to > :asOf)', { asOf })
        .getMany(),
    );
  }
}
