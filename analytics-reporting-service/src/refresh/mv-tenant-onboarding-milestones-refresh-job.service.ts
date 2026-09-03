import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { MIGRATOR_REPLICA_PG_POOL } from '../database/migrator-replica-pool.provider';
import { MetricsService } from '../common/metrics/metrics.service';

const VIEW_NAME = 'mv_tenant_onboarding_milestones';

// Maps this table's stable, friendly `milestone` vocabulary onto the real
// core.audit_log `action` strings that back each one - deliberately kept
// out of the migration/table itself so this refresh job is the one place
// that needs updating if Module 01 ever renames an audit action.
const MILESTONE_ACTIONS: Record<string, string> = {
  tenant_provisioned: 'tenant.provisioned',
  admin_provisioned: 'tenant.admin_provisioned',
  user_invited: 'user.invited',
  invite_accepted: 'user.invite_accepted',
  sso_configured: 'scim_credential.created',
  first_login: 'sso_login.succeeded',
};

// One row per (tenant_id, action) actually observed in core.audit_log, with
// the *first* occurrence only (min(created_at)) - re-running this job never
// moves a milestone's timestamp later, only fills it in the first time it's
// observed. agno_migrator owns the `core` schema (scripts/init-roles.sql),
// so this cross-schema read needs no new grant, same precedent
// `migrator-replica-pool.provider.ts`'s own doc comment documents for
// `compliance.adherence_score`/`forecasting.forecast_accuracy_log`.
const SOURCE_QUERY = `
  SELECT tenant_id, action, min(created_at) AS first_occurred_at
  FROM core.audit_log
  WHERE action = ANY($1::text[])
  GROUP BY tenant_id, action;
`;

const UPSERT_SQL = `
  INSERT INTO analytics_mv.mv_tenant_onboarding_milestones
    (id, tenant_id, milestone, first_occurred_at, computed_at)
  VALUES (gen_random_uuid(), $1, $2, $3, now())
  ON CONFLICT (tenant_id, milestone) DO UPDATE SET
    first_occurred_at = EXCLUDED.first_occurred_at,
    computed_at = now();
`;

interface SourceRow {
  tenant_id: string;
  action: string;
  first_occurred_at: Date;
}

/**
 * Tenant Monitoring dashboard (internal CS tool): reads `core.audit_log`
 * via `MIGRATOR_REPLICA_PG_POOL` and upserts into
 * `analytics_mv.mv_tenant_onboarding_milestones` via `MIGRATOR_PG_POOL`,
 * same shape as every other refresh job in this module
 * (`mv-adherence-trend-rollup-refresh-job.service.ts` is the template) -
 * both pools are `agno_migrator`, bypassing RLS for the same
 * cross-tenant-in-one-tick reason ADR-0098/ADR-0108 already establish for
 * every other job here.
 */
@Injectable()
export class MvTenantOnboardingMilestonesRefreshJobService {
  private readonly logger = new Logger(MvTenantOnboardingMilestonesRefreshJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly primaryPool: Pool,
    @Inject(MIGRATOR_REPLICA_PG_POOL) private readonly replicaPool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  @Cron('15 2 * * *')
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
    const actionToMilestone = new Map(Object.entries(MILESTONE_ACTIONS).map(([milestone, action]) => [action, milestone]));
    const { rows } = await this.replicaPool.query<SourceRow>(SOURCE_QUERY, [Object.values(MILESTONE_ACTIONS)]);

    const client = await this.primaryPool.connect();
    try {
      await client.query('BEGIN');
      let maxObserved: Date | null = null;
      for (const row of rows) {
        const milestone = actionToMilestone.get(row.action);
        if (!milestone) {
          continue;
        }
        await client.query(UPSERT_SQL, [row.tenant_id, milestone, row.first_occurred_at]);
        if (!maxObserved || row.first_occurred_at > maxObserved) {
          maxObserved = row.first_occurred_at;
        }
      }
      await client.query(
        `
        UPDATE analytics_mv.mv_lineage
        SET refreshed_at = now(), data_as_of = COALESCE($1, data_as_of), last_run_status = 'success'
        WHERE view_name = $2;
        `,
        [maxObserved, VIEW_NAME],
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
