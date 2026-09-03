import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { MIGRATOR_REPLICA_PG_POOL } from '../database/migrator-replica-pool.provider';
import { MetricsService } from '../common/metrics/metrics.service';

const VIEW_NAME = 'mv_tenant_health';

// One row per core.tenants row. sso_configured/last_login_at are derived
// from core.audit_log - there is no dedicated session table this service
// can read cross-schema today, so sso_login.succeeded/oauth_token.issued
// (the same "first login" signal the milestones job uses) doubles as the
// last-login proxy here too.
const SOURCE_QUERY = `
  SELECT
    t.id AS tenant_id,
    t.name AS tenant_name,
    t.status,
    t.tier,
    t.created_at AS tenant_created_at,
    EXISTS (
      SELECT 1 FROM core.audit_log a
      WHERE a.tenant_id = t.id AND a.action = 'scim_credential.created'
    ) AS sso_configured,
    (
      SELECT max(a.created_at) FROM core.audit_log a
      WHERE a.tenant_id = t.id AND a.action IN ('sso_login.succeeded', 'oauth_token.issued')
    ) AS last_login_at
  FROM core.tenants t;
`;

const UPSERT_SQL = `
  INSERT INTO analytics_mv.mv_tenant_health
    (id, tenant_id, tenant_name, status, tier, tenant_created_at, sso_configured, last_login_at, computed_at)
  VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, now())
  ON CONFLICT (tenant_id) DO UPDATE SET
    tenant_name = EXCLUDED.tenant_name,
    status = EXCLUDED.status,
    tier = EXCLUDED.tier,
    tenant_created_at = EXCLUDED.tenant_created_at,
    sso_configured = EXCLUDED.sso_configured,
    last_login_at = EXCLUDED.last_login_at,
    computed_at = now();
`;

interface SourceRow {
  tenant_id: string;
  tenant_name: string;
  status: string;
  tier: string;
  tenant_created_at: Date;
  sso_configured: boolean;
  last_login_at: Date | null;
}

/**
 * Tenant Monitoring dashboard (internal CS tool): reads `core.tenants` +
 * `core.audit_log` via `MIGRATOR_REPLICA_PG_POOL` and upserts into
 * `analytics_mv.mv_tenant_health` via `MIGRATOR_PG_POOL`, same shape as
 * every other refresh job here (`mv-adherence-trend-rollup-refresh-job.
 * service.ts` is the template).
 */
@Injectable()
export class MvTenantHealthRefreshJobService {
  private readonly logger = new Logger(MvTenantHealthRefreshJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly primaryPool: Pool,
    @Inject(MIGRATOR_REPLICA_PG_POOL) private readonly replicaPool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  @Cron('20 2 * * *')
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
          row.tenant_name,
          row.status,
          row.tier,
          row.tenant_created_at,
          row.sso_configured,
          row.last_login_at,
        ]);
      }
      await client.query(
        `
        UPDATE analytics_mv.mv_lineage
        SET refreshed_at = now(), data_as_of = now(), last_run_status = 'success'
        WHERE view_name = $1;
        `,
        [VIEW_NAME],
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
