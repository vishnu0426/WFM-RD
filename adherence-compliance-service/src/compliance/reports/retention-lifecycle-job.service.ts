import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../../database/migrator-pool.provider';
import { MetricsService } from '../../common/metrics/metrics.service';
import { getNumberConfig } from '../../common/config/get-number-config';
import { S3ReportStorageService } from './s3-report-storage.service';

const SELECT_EXPIRED_UNHELD_SQL = `
  SELECT id, file_uri
  FROM compliance.compliance_report
  WHERE retention_expires_at < now() AND NOT legal_hold
  LIMIT $1;
`;

const DELETE_REPORT_SQL = `DELETE FROM compliance.compliance_report WHERE id = $1;`;

interface ExpiredReportRow {
  id: string;
  file_uri: string | null;
}

/**
 * §5b/ADR-0096/docs/adr/0106: this service's third `@Cron` job, same shape
 * as Phase 3's two rollup jobs (`MIGRATOR_PG_POOL`-backed cross-tenant
 * sweep, a `ticking` overlap guard, `getNumberConfig`-driven tuning,
 * metrics on every run) - not a new pattern. Daily, not every 15 minutes:
 * retention is not latency-sensitive the way adherence rollups are.
 *
 * Deletes the S3 object *before* the Postgres row, deliberately - a crash
 * between the two steps leaves an orphaned row (safe: still past its
 * expiry and still not legal-held, so the next tick retries it) rather
 * than an orphaned S3 object with no surviving pointer to ever clean it up
 * again. A `DeleteObjectCommand` against an already-deleted key is itself
 * a success by AWS's own design, so a retried row's second S3 delete
 * attempt is never a real error.
 */
@Injectable()
export class RetentionLifecycleJobService {
  private readonly logger = new Logger(RetentionLifecycleJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly s3Storage: S3ReportStorageService,
  ) {}

  @Cron('0 3 * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.sweepExpiredReports();
      this.metrics.recordRetentionLifecycleJobRun('success');
    } catch (err) {
      this.metrics.recordRetentionLifecycleJobRun('error');
      this.logger.error(`Retention lifecycle tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  async sweepExpiredReports(): Promise<void> {
    const batchSize = getNumberConfig(this.config, 'RETENTION_LIFECYCLE_BATCH_SIZE', 100);
    const { rows } = await this.pool.query<ExpiredReportRow>(SELECT_EXPIRED_UNHELD_SQL, [batchSize]);

    for (const row of rows) {
      try {
        if (row.file_uri) {
          await this.s3Storage.deleteObject(row.file_uri);
        }
        await this.pool.query(DELETE_REPORT_SQL, [row.id]);
        this.metrics.recordRetentionLifecycleDeletion('deleted');
      } catch (err) {
        this.metrics.recordRetentionLifecycleDeletion('error');
        this.logger.error(`Failed to delete expired compliance report ${row.id}: ${(err as Error).message}`);
      }
    }
  }
}
