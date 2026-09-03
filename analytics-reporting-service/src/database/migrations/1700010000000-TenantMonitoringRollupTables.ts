import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tenant Onboarding & Health Monitoring (internal CS dashboard): two new
 * `analytics_mv.*` rollup tables, same "plain upserted table, not a real
 * Postgres `MATERIALIZED VIEW`" pattern every other view in this schema
 * uses (see `1700005000000-AdherenceForecastTrendRollupTables.ts`).
 *
 * Both tables are genuinely cross-tenant reads for the CS dashboard's
 * `platform_admin`-only callers, on top of the normal single-tenant reads
 * every other `analytics_mv.*` table serves. Rather than a new Postgres
 * role (disproportionate - every role split in `scripts/init-roles.sql` is
 * a real infra/Terraform provisioning concern, not a repo-only change) or
 * reusing `agno_migrator` in a live request path (`migrator-pool.provider.ts`
 * explicitly documents that role as "internal maintenance jobs only, never
 * add a caller that serves a live user-facing request"), the RLS policy
 * itself grows a second clause: a session GUC (`app.is_platform_monitoring`)
 * set by `withPlatformMonitoringScopedClient`, read by `agno_analytics_app`
 * exactly like `app.current_tenant_id` already is - same idiom, same role,
 * no new grant surface.
 */
export class TenantMonitoringRollupTables1700010000000 implements MigrationInterface {
  name = 'TenantMonitoringRollupTables1700010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const platformMonitoringExpr = `coalesce(current_setting('app.is_platform_monitoring', true)::boolean, false)`;

    // -----------------------------------------------------------------------
    // mv_tenant_onboarding_milestones - first-occurrence timestamp per
    // (tenant_id, milestone), derived from core.audit_log. `milestone` is a
    // friendly, stable vocabulary the refresh job maps audit_log.action
    // strings onto, deliberately decoupled from those action strings so a
    // future rename of e.g. 'scim_credential.created' doesn't ripple into
    // this table's rows or this dashboard's frontend.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE analytics_mv.mv_tenant_onboarding_milestones (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        milestone           varchar(50) NOT NULL,
        first_occurred_at   timestamptz NOT NULL,
        computed_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT mv_tenant_onboarding_milestones_milestone_check
          CHECK (milestone IN (
            'tenant_provisioned', 'admin_provisioned', 'user_invited',
            'invite_accepted', 'sso_configured', 'first_login'
          )),
        CONSTRAINT mv_tenant_onboarding_milestones_upsert_key
          UNIQUE (tenant_id, milestone)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mv_tenant_onboarding_milestones_tenant
      ON analytics_mv.mv_tenant_onboarding_milestones (tenant_id, first_occurred_at);
    `);

    // -----------------------------------------------------------------------
    // mv_tenant_health - one row per tenant, derived from core.tenants +
    // core.audit_log. last_login_at is a proxy (max of sso_login.succeeded /
    // oauth_token.issued) - there is no dedicated "session" table this
    // service can read cross-schema today.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE analytics_mv.mv_tenant_health (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        tenant_name         varchar(255) NOT NULL,
        status              varchar(20) NOT NULL,
        tier                varchar(20) NOT NULL,
        tenant_created_at   timestamptz NOT NULL,
        sso_configured      boolean NOT NULL DEFAULT false,
        last_login_at       timestamptz,
        computed_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT mv_tenant_health_upsert_key UNIQUE (tenant_id)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mv_tenant_health_status ON analytics_mv.mv_tenant_health (status);
    `);

    // -----------------------------------------------------------------------
    // Row Level Security - the usual per-tenant policy, OR'd with the new
    // platform-monitoring session GUC for the CS dashboard's cross-tenant
    // reads. WITH CHECK is omitted: agno_analytics_app only ever gets
    // SELECT on these two tables (writes are agno_migrator, the table
    // owner, which bypasses RLS entirely).
    // -----------------------------------------------------------------------
    for (const table of ['mv_tenant_onboarding_milestones', 'mv_tenant_health']) {
      await queryRunner.query(`ALTER TABLE analytics_mv.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON analytics_mv.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr} OR ${platformMonitoringExpr});
      `);
      await queryRunner.query(`GRANT SELECT ON analytics_mv.${table} TO agno_analytics_app;`);
    }

    // -----------------------------------------------------------------------
    // mv_lineage - documented from day one, same posture as every other
    // view in this schema (1700004100000-SeedMvLineage.ts).
    // -----------------------------------------------------------------------
    const lineageRows: Array<{
      viewName: string;
      sourceDescription: string;
      sourceTables: Array<{ module: string; schema: string; table: string }>;
      queryPatternDescription: string;
    }> = [
      {
        viewName: 'mv_tenant_onboarding_milestones',
        sourceDescription:
          "Re-derives per-tenant onboarding milestones from Module 01's core.audit_log (first occurrence of " +
          "tenant.provisioned / tenant.admin_provisioned / user.invited / user.invite_accepted / " +
          "scim_credential.created / sso_login.succeeded per tenant). Internal CS/platform_admin dashboard only " +
          '- not exposed to tenant-scoped callers.',
        sourceTables: [{ module: 'module-01', schema: 'core', table: 'audit_log' }],
        queryPatternDescription:
          'Internal Tenant Monitoring dashboard onboarding-funnel view: GET /v1/tenant-monitoring/onboarding-funnel, ' +
          'a full cross-tenant read, platform_admin-only.',
      },
      {
        viewName: 'mv_tenant_health',
        sourceDescription:
          "One row per core.tenants row, joined against core.audit_log for sso_configured " +
          "(scim_credential.created existence) and last_login_at (max of sso_login.succeeded / " +
          'oauth_token.issued). Internal CS/platform_admin dashboard only.',
        sourceTables: [
          { module: 'module-01', schema: 'core', table: 'tenants' },
          { module: 'module-01', schema: 'core', table: 'audit_log' },
        ],
        queryPatternDescription:
          'Internal Tenant Monitoring dashboard tenant-health view: GET /v1/tenant-monitoring/health, a full ' +
          'cross-tenant read, platform_admin-only.',
      },
    ];
    for (const row of lineageRows) {
      await queryRunner.query(
        `
        INSERT INTO analytics_mv.mv_lineage
          (view_name, source_description, source_tables, refresh_cadence, query_pattern_description, created_at)
        VALUES ($1, $2, $3::jsonb, 'daily', $4, now());
        `,
        [row.viewName, row.sourceDescription, JSON.stringify(row.sourceTables), row.queryPatternDescription],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM analytics_mv.mv_lineage
      WHERE view_name IN ('mv_tenant_onboarding_milestones', 'mv_tenant_health');
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS analytics_mv.mv_tenant_onboarding_milestones;`);
    await queryRunner.query(`DROP TABLE IF EXISTS analytics_mv.mv_tenant_health;`);
  }
}
