import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 05 Phase 5 (§2.1/§5a, ADR-0069): `intraday.alert` (the dedup/
 * suppression/escalation pipeline's persisted state) and
 * `intraday.alert_policy` (the tenant-configurable dedup/suppression/
 * escalation windows and suppression rules §5a asks for) - additive to
 * the `intraday` schema Phase 3 already created, same RLS/role convention.
 *
 * `alert` carries three columns beyond §2.1's literal field list -
 * `last_triggered_at`, `escalated_at`, `resolved_at` - all necessary for
 * the pipeline to function (see design doc's explicit assumption 1), not
 * arbitrary additions.
 */
export class AlertSchema1700000300000 implements MigrationInterface {
  name = 'AlertSchema1700000300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE intraday.alert (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        alert_type          varchar(50) NOT NULL,
        severity            varchar(20) NOT NULL,
        org_unit_id         uuid,
        queue_id            uuid,
        status              varchar(20) NOT NULL,
        dedup_group_id      uuid NOT NULL,
        created_at          timestamptz NOT NULL DEFAULT now(),
        last_triggered_at   timestamptz NOT NULL DEFAULT now(),
        escalated_at        timestamptz,
        acknowledged_by     uuid,
        acknowledged_at     timestamptz,
        resolved_at         timestamptz,
        CONSTRAINT alert_severity_check CHECK (severity IN ('warning', 'critical')),
        CONSTRAINT alert_status_check CHECK (status IN ('open', 'acknowledged', 'suppressed', 'resolved')),
        PRIMARY KEY (id)
      );
    `);
    // The dedup/suppression lookup's own access pattern: "is there an
    // active alert for this (tenant, queue, alert_type) right now."
    await queryRunner.query(`
      CREATE INDEX idx_alert_tenant_queue_type_status
      ON intraday.alert (tenant_id, queue_id, alert_type, status);
    `);
    // activeAlerts' own access pattern.
    await queryRunner.query(`
      CREATE INDEX idx_alert_tenant_status ON intraday.alert (tenant_id, status);
    `);
    // AlertEscalationSchedulerService's own access pattern: "open alerts older than N minutes."
    await queryRunner.query(`
      CREATE INDEX idx_alert_tenant_status_created_at ON intraday.alert (tenant_id, status, created_at);
    `);

    await queryRunner.query(`
      CREATE TABLE intraday.alert_policy (
        tenant_id                        uuid NOT NULL,
        dedup_window_minutes             integer NOT NULL DEFAULT 5,
        suppression_ack_window_minutes   integer NOT NULL DEFAULT 15,
        escalation_threshold_minutes     integer NOT NULL DEFAULT 15,
        suppression_rules                jsonb NOT NULL DEFAULT '[]'::jsonb,
        PRIMARY KEY (tenant_id)
      );
    `);

    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    for (const table of ['alert', 'alert_policy']) {
      await queryRunner.query(`ALTER TABLE intraday.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON intraday.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON intraday.alert TO agno_intraday_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON intraday.alert_policy TO agno_intraday_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS intraday.alert_policy;`);
    await queryRunner.query(`DROP TABLE IF EXISTS intraday.alert;`);
  }
}
