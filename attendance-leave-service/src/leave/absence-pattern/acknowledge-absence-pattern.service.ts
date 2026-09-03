import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AbsencePattern } from '../entities/absence-pattern.entity';
import { AcknowledgeAbsencePatternDto } from './dto/acknowledge-absence-pattern.dto';
import { AbsencePatternNotFoundError } from '../../common/errors/absence-pattern-not-found.error';
import { AbsencePatternAlreadyAcknowledgedError } from '../../common/errors/absence-pattern-already-acknowledged.error';
import { MetricsService } from '../../common/metrics/metrics.service';
import { withTenantConnection } from '../../database/with-tenant-connection';

/**
 * §2.2 rule 4: `acknowledgedBy` gates all downstream action - the one
 * concrete enforcement point this phase can point to is
 * `AbsencePatternDetectionJob`'s own dedup query (`WHERE acknowledged_by
 * IS NULL`), which is exactly why acknowledging a pattern here matters:
 * it is what lets the *next* detection run create a fresh row if the
 * behavior continues, instead of leaving a single stale row nobody
 * revisits. No other automated action anywhere in this platform consumes
 * `AbsencePattern` rows today (no notification pipeline exists - the same
 * gap Phase 4/7 already documented); the gate's job right now is
 * specifically to keep the "is there anything actionable" view (the list
 * endpoint, and the job's own dedup check) from accumulating duplicate
 * unacknowledged noise for the same ongoing pattern.
 */
@Injectable()
export class AcknowledgeAbsencePatternService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {}

  async acknowledge(tenantId: string, id: string, dto: AcknowledgeAbsencePatternDto): Promise<AbsencePattern> {
    try {
      const result = await withTenantConnection(this.dataSource, tenantId, (manager) =>
        this.applyAcknowledgement(manager, tenantId, id, dto),
      );
      this.metrics.recordAbsencePatternAcknowledgement('acknowledged');
      return result;
    } catch (err) {
      this.metrics.recordAbsencePatternAcknowledgement(
        err instanceof AbsencePatternNotFoundError || err instanceof AbsencePatternAlreadyAcknowledgedError
          ? 'rejected'
          : 'error',
      );
      throw err;
    }
  }

  private async applyAcknowledgement(
    manager: EntityManager,
    tenantId: string,
    id: string,
    dto: AcknowledgeAbsencePatternDto,
  ): Promise<AbsencePattern> {
    const pattern = await manager
      .createQueryBuilder(AbsencePattern, 'pattern')
      .setLock('pessimistic_write')
      .where('pattern.id = :id', { id })
      .andWhere('pattern.tenantId = :tenantId', { tenantId })
      .getOne();
    if (!pattern) {
      throw new AbsencePatternNotFoundError(id);
    }
    if (pattern.acknowledgedBy) {
      throw new AbsencePatternAlreadyAcknowledgedError(id, pattern.acknowledgedBy);
    }

    await manager.update(AbsencePattern, { id }, { acknowledgedBy: dto.acknowledgedBy, outcome: dto.outcome });
    return manager.findOneByOrFail(AbsencePattern, { id });
  }
}
