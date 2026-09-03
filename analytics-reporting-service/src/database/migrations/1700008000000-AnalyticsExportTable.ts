import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 09 Phase 6 (§4.2/§1's async-export requirement): `analytics.
 * analytics_export` - the job-tracking table `POST /v1/analytics/exports`
 * inserts into and `GET .../download` reads from. Request-scoped CRUD
 * (`agno_analytics_app`, `withTenantConnection`), not a cross-tenant batch
 * job - unlike every `analytics_mv.mv_*` table, this one is written by the
 * request path itself, the same shape as `SavedReport`/`DashboardWidget`.
 *
 * `status`/`file_uri`'s "only non-null once completed" shape mirrors
 * Module 08's own `ComplianceReport` (§2.1/§5b there) - `generateComplianceReport`
 * is async and needs to represent "accepted, not ready yet" distinctly
 * from "failed," and so does this table. Unlike `ComplianceReport`, this
 * table has no `retention_expires_at`/`legal_hold` - no §5b-equivalent
 * legal retention requirement exists anywhere in this module's own spec
 * for an analytics export, so none is added speculatively.
 *
 * `idempotency_key` is nullable with a partial unique index
 * (`tenant_id, idempotency_key`) - see `AnalyticsExportService`'s own doc
 * comment for why this module implements idempotency itself (a real,
 * confirmed gap in Module 08's own report generator, which this module's
 * spec was told to copy "the same job pattern" from) rather than reusing
 * either of this platform's two existing idempotency mechanisms (neither
 * is reachable from this standalone service without adding an unrelated
 * new dependency).
 */
export class AnalyticsExportTable1700008000000 implements MigrationInterface {
  name = 'AnalyticsExportTable1700008000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      CREATE TABLE analytics.analytics_export (
        id                uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        requested_by      uuid NOT NULL,
        metric_name       varchar(200) NOT NULL,
        filter            jsonb NOT NULL DEFAULT '{}'::jsonb,
        status            varchar(20) NOT NULL DEFAULT 'pending',
        file_uri          text,
        row_count         integer,
        error_message     text,
        idempotency_key   varchar(200),
        requested_at      timestamptz NOT NULL DEFAULT now(),
        completed_at      timestamptz,
        PRIMARY KEY (id),
        CONSTRAINT analytics_export_status_check CHECK (status IN ('pending', 'completed', 'failed')),
        -- file_uri is only ever non-null once generation actually succeeds -
        -- same invariant as compliance_report_file_uri_completed_check.
        CONSTRAINT analytics_export_file_uri_completed_check
          CHECK (status <> 'completed' OR file_uri IS NOT NULL)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_analytics_export_tenant_requested_by
      ON analytics.analytics_export (tenant_id, requested_by, requested_at DESC);
    `);
    // The idempotency check itself - a retry with the same key must find
    // this row, not race a second INSERT past it.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_analytics_export_tenant_idempotency_key
      ON analytics.analytics_export (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);

    await queryRunner.query(`ALTER TABLE analytics.analytics_export ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON analytics.analytics_export FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON analytics.analytics_export TO agno_analytics_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS analytics.analytics_export;`);
  }
}
