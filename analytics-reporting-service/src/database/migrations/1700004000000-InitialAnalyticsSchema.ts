import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 09 Phase 1 (§2, §8 Phase 1, ADR-0108): the §2.1 entity set
 * (`SavedReport`, `MetricDefinition`, `DashboardWidget`) in a new
 * `analytics` schema, plus the `analytics_mv` schema skeleton (§2.2) with
 * its `mv_lineage` documentation table - no materialized view object and
 * no populated lineage row yet (that is Phase 2/3, seeded separately by
 * `SeedMvLineage`). Same shared-database/new-schema/new-role pattern as
 * every prior module (ADR-0017/0052/0066/0073/0083/0093), and the same
 * `app.current_tenant_id` RLS convention (ADR-0002). Enum-typed columns are
 * `varchar` + `CHECK`, not native Postgres `ENUM` (ADR-0003).
 *
 * `metric_definition` gets the same nullable-`tenant_id`-as-platform-default
 * shape ADR-0095 established for `compliance_rule`/`retention_policy` - a
 * global metric definition, visible to (but not writable as null by) every
 * tenant. `saved_report`/`dashboard_widget` are uniformly tenant-scoped.
 * `mv_lineage` is schema-describing metadata about the views this service
 * owns, not tenant data - no `tenant_id`, no RLS, same posture this
 * platform gives any other schema/config-describing table.
 */
export class InitialAnalyticsSchema1700004000000 implements MigrationInterface {
  name = 'InitialAnalyticsSchema1700004000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS analytics;`);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS analytics_mv;`);

    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -----------------------------------------------------------------------
    // saved_report (§2.1)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE analytics.saved_report (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        created_by     uuid NOT NULL,
        report_type    varchar(20) NOT NULL,
        config         jsonb NOT NULL,
        schedule_cron  varchar(100),
        shared_with    jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT saved_report_type_check
          CHECK (report_type IN ('dashboard', 'scheduled_export', 'ad_hoc')),
        -- §2.3 rule 3: schedule_cron only makes sense for a scheduled_export;
        -- a dashboard/ad_hoc report has no cron of its own to run on.
        CONSTRAINT saved_report_schedule_cron_scoped_check
          CHECK (schedule_cron IS NULL OR report_type = 'scheduled_export')
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_saved_report_tenant_created_by
      ON analytics.saved_report (tenant_id, created_by);
    `);
    // Phase 4's dashboard() / myDashboards() reads (§4.1).
    await queryRunner.query(`
      CREATE INDEX idx_saved_report_tenant_type
      ON analytics.saved_report (tenant_id, report_type);
    `);

    // -----------------------------------------------------------------------
    // metric_definition (§2.1, ADR-0095's nullable-tenant_id precedent)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE analytics.metric_definition (
        id                       uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                uuid,
        name                     varchar(200) NOT NULL,
        calculation_definition   jsonb NOT NULL,
        category                 varchar(30) NOT NULL,
        validated_at             timestamptz,
        estimated_cost_tier      varchar(10),
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT metric_definition_category_check
          CHECK (category IN ('attendance', 'occupancy', 'cost', 'performance', 'forecast_accuracy')),
        CONSTRAINT metric_definition_cost_tier_check
          CHECK (estimated_cost_tier IS NULL OR estimated_cost_tier IN ('cheap', 'moderate', 'expensive'))
      );
    `);
    // §2.2 rule 3's versioning invariant shape, restated for names: a
    // platform-default metric name and a tenant-authored metric name each
    // need to be unique within their own scope, split across two partial
    // unique indexes for the same NULL-never-equals-NULL reason ADR-0095
    // documents for compliance_rule.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_metric_definition_platform_default_name
      ON analytics.metric_definition (name)
      WHERE tenant_id IS NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_metric_definition_tenant_name
      ON analytics.metric_definition (tenant_id, name)
      WHERE tenant_id IS NOT NULL;
    `);
    // §0.5's progressive-delivery gate (Phase 5): "which metrics are usable
    // on a live widget" is exactly `estimated_cost_tier <> 'expensive'`.
    await queryRunner.query(`
      CREATE INDEX idx_metric_definition_tenant_category_cost_tier
      ON analytics.metric_definition (tenant_id, category, estimated_cost_tier);
    `);

    // -----------------------------------------------------------------------
    // dashboard_widget (§2.1)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE analytics.dashboard_widget (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        dashboard_id   uuid NOT NULL,
        widget_type    varchar(50) NOT NULL,
        metric_id      uuid NOT NULL,
        position       jsonb NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT dashboard_widget_dashboard_fk
          FOREIGN KEY (dashboard_id) REFERENCES analytics.saved_report (id),
        CONSTRAINT dashboard_widget_metric_fk
          FOREIGN KEY (metric_id) REFERENCES analytics.metric_definition (id)
      );
    `);
    // Phase 4's dashboard(id)'s "load every widget for this dashboard" read.
    await queryRunner.query(`
      CREATE INDEX idx_dashboard_widget_dashboard
      ON analytics.dashboard_widget (dashboard_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_dashboard_widget_tenant
      ON analytics.dashboard_widget (tenant_id);
    `);

    // -----------------------------------------------------------------------
    // analytics_mv.mv_lineage (§0.6/§2.2 - the lineage/documentation record,
    // not tenant data; no RLS)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE analytics_mv.mv_lineage (
        view_name                   varchar(60) NOT NULL,
        source_description          text NOT NULL,
        source_tables               jsonb NOT NULL,
        refresh_cadence             varchar(10) NOT NULL,
        query_pattern_description   text NOT NULL,
        refreshed_at                timestamptz,
        data_as_of                  timestamptz,
        last_run_status             varchar(10),
        created_at                  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (view_name),
        CONSTRAINT mv_lineage_refresh_cadence_check CHECK (refresh_cadence IN ('hourly', 'daily')),
        CONSTRAINT mv_lineage_last_run_status_check
          CHECK (last_run_status IS NULL OR last_run_status IN ('success', 'failed')),
        -- §2.3 rule 1: data_as_of can never be newer than the refresh run
        -- that produced it.
        CONSTRAINT mv_lineage_data_as_of_not_after_refresh_check
          CHECK (data_as_of IS NULL OR refreshed_at IS NULL OR data_as_of <= refreshed_at)
      );
    `);

    // -----------------------------------------------------------------------
    // Row Level Security (ADR-0002) - saved_report/dashboard_widget get the
    // uniform tenant-scoped policy; metric_definition gets the
    // nullable-tenant-aware policy (ADR-0095's precedent); mv_lineage gets
    // none (not tenant data).
    // -----------------------------------------------------------------------
    for (const table of ['saved_report', 'dashboard_widget']) {
      await queryRunner.query(`ALTER TABLE analytics.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON analytics.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }
    await queryRunner.query(`ALTER TABLE analytics.metric_definition ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON analytics.metric_definition FOR ALL
      USING (tenant_id = ${tenantIdExpr} OR tenant_id IS NULL)
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    // -----------------------------------------------------------------------
    // Grants - agno_analytics_app is the runtime role, scoped to `analytics`/
    // `analytics_mv` only. No DELETE anywhere in this schema (this module's
    // own §2/§8 scope has no row-level-delete requirement analogous to
    // Module 08's retention lifecycle job). No CREATE on either schema.
    // -----------------------------------------------------------------------
    await queryRunner.query(`GRANT USAGE ON SCHEMA analytics TO agno_analytics_app;`);
    await queryRunner.query(`GRANT USAGE ON SCHEMA analytics_mv TO agno_analytics_app;`);
    for (const table of ['saved_report', 'metric_definition', 'dashboard_widget']) {
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON analytics.${table} TO agno_analytics_app;`);
    }
    // mv_lineage's refreshed_at/data_as_of/last_run_status are written by
    // the Phase 2/3 refresh runner via this same role - no INSERT needed at
    // runtime (rows are seeded once by migration), only UPDATE + SELECT.
    await queryRunner.query(`GRANT SELECT, UPDATE ON analytics_mv.mv_lineage TO agno_analytics_app;`);
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA analytics FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA analytics_mv FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS analytics CASCADE;`);
    await queryRunner.query(`DROP SCHEMA IF EXISTS analytics_mv CASCADE;`);
  }
}
