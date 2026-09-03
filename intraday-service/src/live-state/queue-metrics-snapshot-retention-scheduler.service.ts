import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';

/** This table backs degraded-mode display only, not analytics (the rollup tables already own that) - a flat, generous-enough-to-be-useful-but-bounded window. */
const RETENTION_DAYS = 7;

/**
 * §6.1/ADR-0071: `queue_metrics_snapshot`'s retention job - same
 * cross-tenant, `MIGRATOR_PG_POOL`-based pattern as
 * `AdherencePartitionSchedulerService`/`AdherenceRollupSchedulerService`
 * (Phase 3): a daily cleanup is genuinely cross-tenant (one tick prunes
 * every tenant's stale snapshots), and RLS's `ENABLE`-not-`FORCE` posture
 * means only the table owner queries/deletes across tenants without
 * per-request `app.current_tenant_id` scoping.
 */
@Injectable()
export class QueueMetricsSnapshotRetentionSchedulerService {
  private readonly logger = new Logger(QueueMetricsSnapshotRetentionSchedulerService.name);
  private ticking = false;

  constructor(@Inject(MIGRATOR_PG_POOL) private readonly pool: Pool) {}

  @Cron('0 2 * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const result = await this.pool.query(
        `DELETE FROM intraday.queue_metrics_snapshot WHERE captured_at < now() - ($1 || ' days')::interval`,
        [RETENTION_DAYS],
      );
      if (result.rowCount && result.rowCount > 0) {
        this.logger.log(`Pruned ${result.rowCount} queue_metrics_snapshot rows older than ${RETENTION_DAYS}d`);
      }
    } catch (err) {
      this.logger.error(`queue_metrics_snapshot retention tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
