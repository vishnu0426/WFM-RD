import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { ReallocationAction } from './entities/reallocation-action.entity';

/** docs/adr/0122: `ListReallocationsForPeriod`'s own cap - see that RPC's proto doc comment for why a bounded list, not a stream. */
const LIST_FOR_PERIOD_LIMIT = 100;

/** `pendingReallocations` (§4.1 gap - see design doc assumption 8: without this, `approveReallocation` has no way to discover a suggestion's id in practice). */
@Injectable()
export class ReallocationQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listPendingReallocations(tenantId: string): Promise<ReallocationAction[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(ReallocationAction).find({
        where: { tenantId, status: 'suggested' },
        order: { createdAt: 'DESC' },
      }),
    );
  }

  /** Module 10 Phase 4 (docs/adr/0120) - `ReallocationGrpcController`'s own read, any status (not just 'suggested'). */
  async getById(tenantId: string, id: string): Promise<ReallocationAction | null> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(ReallocationAction).findOne({ where: { tenantId, id } }),
    );
  }

  /** Module 10 Phase 4 (docs/adr/0122) - `root_cause_analysis`'s reallocation-churn source. Tenant-wide (no org_unit_id column on this entity), newest-first, capped. */
  async listForPeriod(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<{ rows: ReallocationAction[]; totalMatchedBeforeCap: number }> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const qb = manager
        .getRepository(ReallocationAction)
        .createQueryBuilder('action')
        .where('action.tenant_id = :tenantId', { tenantId })
        .andWhere('action.created_at >= :periodStart', { periodStart })
        .andWhere('action.created_at < :periodEnd', { periodEnd });

      const totalMatchedBeforeCap = await qb.getCount();
      const rows = await qb.clone().orderBy('action.created_at', 'DESC').limit(LIST_FOR_PERIOD_LIMIT).getMany();
      return { rows, totalMatchedBeforeCap };
    });
  }
}
