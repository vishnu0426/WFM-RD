import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 05 Phase 6 (§2.1, ADR-0070): `intraday.reallocation_action`,
 * additive to the `intraday` schema, same RLS/role convention as
 * `alert`/`alert_policy` (Phase 5).
 *
 * `ai_rationale` is nullable at the type level but the CHECK constraint
 * below enforces §2.2 rule 3 - "mandatory before `approved` or
 * `auto_executed`" - the same enforcement shape as Module 01's own
 * `audit_log_ai_rationale_required` CHECK
 * (`src/database/migrations/1700000000000-InitialSchema.ts`).
 */
export class ReallocationSchema1700000400000 implements MigrationInterface {
  name = 'ReallocationSchema1700000400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE intraday.reallocation_action (
        id                      uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id               uuid NOT NULL,
        triggered_by            varchar(30) NOT NULL,
        from_queue_id           uuid NOT NULL,
        to_queue_id             uuid NOT NULL,
        affected_employee_ids   uuid[] NOT NULL,
        reason                  varchar(500) NOT NULL,
        status                  varchar(20) NOT NULL,
        ai_rationale            jsonb,
        created_at              timestamptz NOT NULL DEFAULT now(),
        executed_at             timestamptz,
        CONSTRAINT reallocation_action_triggered_by_check CHECK (triggered_by IN ('system_recommendation', 'supervisor_manual')),
        CONSTRAINT reallocation_action_status_check CHECK (status IN ('suggested', 'approved', 'rejected', 'auto_executed', 'executed')),
        CONSTRAINT reallocation_action_ai_rationale_required CHECK (status NOT IN ('approved', 'auto_executed') OR ai_rationale IS NOT NULL),
        PRIMARY KEY (id)
      );
    `);
    // pendingReallocations' own access pattern.
    await queryRunner.query(`
      CREATE INDEX idx_reallocation_action_tenant_status ON intraday.reallocation_action (tenant_id, status);
    `);
    // The repeat-guard's own access pattern: "is there already a suggested/approved row for this (tenant, from_queue, to_queue) pair."
    await queryRunner.query(`
      CREATE INDEX idx_reallocation_action_tenant_from_to_status
      ON intraday.reallocation_action (tenant_id, from_queue_id, to_queue_id, status);
    `);

    await queryRunner.query(`ALTER TABLE intraday.reallocation_action ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON intraday.reallocation_action FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
    `);

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON intraday.reallocation_action TO agno_intraday_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS intraday.reallocation_action;`);
  }
}
