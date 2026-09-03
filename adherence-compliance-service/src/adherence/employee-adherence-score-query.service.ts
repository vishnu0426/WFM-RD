import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AdherenceScore, AdherenceScorePeriodType } from './entities/adherence-score.entity';

/**
 * Module 11 Phase 7 (docs/adr/0156): the first per-employee read of
 * `AdherenceScore` - `AdherenceRollupService` (§7 Phase 4, ADR-0121) only
 * ever aggregates across a roster for root-cause analysis; this is a
 * single employee's own `periodType: 'day'` row, "as of right now."
 *
 * `periodStart <= now < periodEnd` (not `periodStart = today's midnight`)
 * deliberately avoids reimplementing `TimezoneResolverService`'s own
 * local-day math on the read side - "now falls inside this period's
 * range" is correct regardless of which timezone was used to compute
 * those instants when the rollup job wrote them.
 */
@Injectable()
export class EmployeeAdherenceScoreQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async getTodayScore(tenantId: string, employeeId: string): Promise<AdherenceScore | null> {
    const now = new Date();
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager
        .getRepository(AdherenceScore)
        .createQueryBuilder('score')
        .where('score.employee_id = :employeeId', { employeeId })
        .andWhere('score.period_type = :periodType', { periodType: AdherenceScorePeriodType.DAY })
        .andWhere('score.period_start <= :now', { now })
        .andWhere('score.period_end > :now', { now })
        .getOne(),
    );
  }
}
