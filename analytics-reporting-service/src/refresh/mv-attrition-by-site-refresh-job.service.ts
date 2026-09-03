import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { MIGRATOR_REPLICA_PG_POOL } from '../database/migrator-replica-pool.provider';
import { MetricsService } from '../common/metrics/metrics.service';

const VIEW_NAME = 'mv_attrition_by_site';

// `eu.path <@ site.path` is ltree's descendant-or-equal operator: site is
// an ancestor of (or the same row as) the employee's own org unit. An
// employee assigned directly to a site-type org unit is included
// (reflexive); an employee with no site-type ancestor anywhere above them
// produces no row - excluded, not attributed to a fabricated site.
// max_observed_at is employees.updated_at - the real timestamp the
// termination was actually recorded, never termination_date itself
// treated as an observation instant (it's a date, not a timestamp, and
// backdating is possible - updated_at is when this fact became known).
const SOURCE_QUERY = `
  SELECT e.tenant_id, site.id AS site_org_unit_id,
         date_trunc('month', e.termination_date::timestamptz) AS period_start,
         count(*) AS terminations_count,
         max(e.updated_at) AS max_observed_at
  FROM org.employees e
  JOIN org.org_units eu ON eu.tenant_id = e.tenant_id AND eu.id = e.org_unit_id
  JOIN org.org_units site ON site.tenant_id = e.tenant_id AND site.type = 'site' AND eu.path <@ site.path
  WHERE e.termination_date IS NOT NULL
  GROUP BY e.tenant_id, site.id, date_trunc('month', e.termination_date::timestamptz);
`;

const UPSERT_SQL = `
  INSERT INTO analytics_mv.mv_attrition_by_site
    (id, tenant_id, site_org_unit_id, period_start, period_end, terminations_count, computed_at)
  VALUES (gen_random_uuid(), $1, $2, $3::timestamptz, $3::timestamptz + interval '1 month', $4, now())
  ON CONFLICT (tenant_id, site_org_unit_id, period_start) DO UPDATE SET
    period_end = EXCLUDED.period_end,
    terminations_count = EXCLUDED.terminations_count,
    computed_at = now();
`;

interface SourceRow {
  tenant_id: string;
  site_org_unit_id: string;
  period_start: Date;
  terminations_count: string;
  max_observed_at: Date;
}

/**
 * Phase 3 (§8 Phase 3, ADR-0108): `org.employees.termination_date` joined
 * to its nearest `type = 'site'` org-unit ancestor. Same two-pool,
 * `agno_migrator`-on-both-ends shape as every other refresh job in this
 * module (ADR-0098's precedent). Reports `terminations_count` only - no
 * headcount/rate, see the migration that creates this table for why a
 * real attrition rate is out of scope for this phase.
 */
@Injectable()
export class MvAttritionBySiteRefreshJobService {
  private readonly logger = new Logger(MvAttritionBySiteRefreshJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly primaryPool: Pool,
    @Inject(MIGRATOR_REPLICA_PG_POOL) private readonly replicaPool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  @Cron('30 3 * * *')
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
        await client.query(UPSERT_SQL, [row.tenant_id, row.site_org_unit_id, row.period_start, row.terminations_count]);
      }
      const dataAsOf = rows.length > 0 ? maxObservedAt(rows) : null;
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

function maxObservedAt(rows: SourceRow[]): Date {
  return rows.reduce((max, row) => (row.max_observed_at > max ? row.max_observed_at : max), rows[0].max_observed_at);
}
