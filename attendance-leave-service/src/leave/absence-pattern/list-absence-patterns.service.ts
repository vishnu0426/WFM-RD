import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AbsencePattern } from '../entities/absence-pattern.entity';
import { withTenantConnection } from '../../database/with-tenant-connection';

/**
 * §2.2 rule 4's own framing ("is there anything actionable") is exactly
 * `idx_absence_pattern_tenant_unacknowledged` (Phase 1's own partial
 * index, built for this query before this query existed) - `ORDER BY
 * detected_at DESC` matches that index's own column order, so this is an
 * index-only scan, not a sort.
 */
@Injectable()
export class ListAbsencePatternsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listUnacknowledged(tenantId: string): Promise<AbsencePattern[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager
        .createQueryBuilder(AbsencePattern, 'pattern')
        .where('pattern.tenantId = :tenantId', { tenantId })
        .andWhere('pattern.acknowledgedBy IS NULL')
        .orderBy('pattern.detectedAt', 'DESC')
        .getMany(),
    );
  }
}
