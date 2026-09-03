import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { MIGRATOR_REPLICA_PG_POOL } from '../database/migrator-replica-pool.provider';
import { MetricsService } from '../common/metrics/metrics.service';

const VIEW_NAME = 'mv_forecast_accuracy_trend';

// date_trunc('day', ...) is safe here specifically because
// migrator-replica-pool.provider.ts fixes this connection's session
// timezone to UTC (`options: '-c TimeZone=UTC'`) - see that file's own doc
// comment for the pitfall this sidesteps (ADR-0098). mape IS NOT NULL
// excludes forecast_accuracy_log rows logged before an actual value
// existed to compare against (the column is nullable in Module 03's own
// schema); a row with no mape contributes nothing to this trend rather
// than being coerced into a 0 that would understate error.
const SOURCE_QUERY = `
  SELECT tenant_id, org_unit_id, date_trunc('day', evaluated_at) AS period_start,
         avg(mape) AS avg_mape,
         avg(bias) AS avg_bias,
         count(*) AS forecast_count
  FROM forecasting.forecast_accuracy_log
  WHERE mape IS NOT NULL
  GROUP BY tenant_id, org_unit_id, date_trunc('day', evaluated_at);
`;

const UPSERT_SQL = `
  INSERT INTO analytics_mv.mv_forecast_accuracy_trend
    (id, tenant_id, org_unit_id, period_start, period_end, avg_mape, avg_bias, forecast_count, computed_at)
  VALUES (gen_random_uuid(), $1, $2, $3::timestamptz, $3::timestamptz + interval '1 day', $4, $5, $6, now())
  ON CONFLICT (tenant_id, org_unit_id, period_start) DO UPDATE SET
    period_end = EXCLUDED.period_end,
    avg_mape = EXCLUDED.avg_mape,
    avg_bias = EXCLUDED.avg_bias,
    forecast_count = EXCLUDED.forecast_count,
    computed_at = now();
`;

interface SourceRow {
  tenant_id: string;
  org_unit_id: string;
  period_start: Date;
  avg_mape: string | null;
  avg_bias: string | null;
  forecast_count: string;
}

/**
 * Phase 2 (§8 Phase 2, ADR-0108): re-aggregates Module 03's
 * `forecasting.forecast_accuracy_log` into daily `(tenant_id, org_unit_id)`
 * buckets. Same two-pool/two-host, `agno_migrator`-on-both-ends shape as
 * `MvAdherenceTrendRollupRefreshJobService` - see that file's own doc
 * comment for why (ADR-0098's RLS-owner-bypass precedent, applied here to
 * a second source table).
 *
 * `data_as_of` is the max `evaluated_at` actually observed in the source
 * data this tick (not `now()`), truncated to the same UTC day boundary the
 * upserted rows themselves use - the freshness a caller should trust is
 * "as of the latest forecast-accuracy evaluation Module 03 has logged."
 */
@Injectable()
export class MvForecastAccuracyTrendRefreshJobService {
  private readonly logger = new Logger(MvForecastAccuracyTrendRefreshJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly primaryPool: Pool,
    @Inject(MIGRATOR_REPLICA_PG_POOL) private readonly replicaPool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  @Cron('30 2 * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.refresh();
      this.metrics.mvRefreshJobRunsTotal.inc({ view_name: VIEW_NAME, result: 'completed' });
    } catch (err) {
      this.metrics.mvRefreshJobRunsTotal.inc({ view_name: VIEW_NAME, result: 'failed' });
      this.logger.error(`${VIEW_NAME} refresh failed: ${(err as Error).message}`);
      await this.markFailed();
    } finally {
      this.ticking = false;
    }
  }

  async refresh(): Promise<void> {
    const { rows } = await this.replicaPool.query<SourceRow>(SOURCE_QUERY);

    const client = await this.primaryPool.connect();
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        await client.query(UPSERT_SQL, [
          row.tenant_id,
          row.org_unit_id,
          row.period_start,
          row.avg_mape,
          row.avg_bias,
          row.forecast_count,
        ]);
      }
      const dataAsOf = rows.length > 0 ? maxPeriodStart(rows) : null;
      await client.query(
        `
        UPDATE analytics_mv.mv_lineage
        SET refreshed_at = now(), data_as_of = COALESCE($1, data_as_of), last_run_status = 'success'
        WHERE view_name = $2;
        `,
        [dataAsOf, VIEW_NAME],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async markFailed(): Promise<void> {
    await this.primaryPool.query(
      `UPDATE analytics_mv.mv_lineage SET last_run_status = 'failed' WHERE view_name = $1;`,
      [VIEW_NAME],
    );
  }
}

function maxPeriodStart(rows: SourceRow[]): Date {
  return rows.reduce((max, row) => (row.period_start > max ? row.period_start : max), rows[0].period_start);
}
