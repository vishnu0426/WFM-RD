import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 02 Phase 4 — checkpoint table backing the nightly skill-decay job
 * (§5) and a `core.policies` extension for its tenant-configurable half-life
 * (§5's decay function). See docs/adr/0017-decay-job-scheduling-and-resumability.md.
 */
export class Module02SkillDecayJob1700000002000 implements MigrationInterface {
  name = 'Module02SkillDecayJob1700000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ADR-0017: one row per (tenant, run_date) - the resumability checkpoint.
    await queryRunner.query(`
      CREATE TABLE org.decay_job_runs (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                   uuid NOT NULL REFERENCES core.tenants(id),
        run_date                    date NOT NULL,
        status                      varchar(20) NOT NULL DEFAULT 'running',
        started_at                  timestamptz NOT NULL DEFAULT now(),
        completed_at                timestamptz,
        last_processed_employee_id  uuid,
        employees_processed         integer NOT NULL DEFAULT 0,
        failures_count              integer NOT NULL DEFAULT 0,
        CONSTRAINT decay_job_runs_status_check CHECK (status IN ('running','completed','failed')),
        CONSTRAINT uq_decay_job_runs_tenant_id_run_date UNIQUE (tenant_id, run_date)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_decay_job_runs_tenant_id_status ON org.decay_job_runs (tenant_id, status);`,
    );

    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    await queryRunner.query(`ALTER TABLE org.decay_job_runs ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON org.decay_job_runs FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);
    // No DELETE - a job run row is a durable audit trail of what happened
    // and when, same posture as core.audit_log (§2.2 rule 2 precedent).
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON org.decay_job_runs TO agno_app;`);

    // §5 requires the decay job to "respect WorkingTimeCalendar.timezone,"
    // but §2.1's WorkingTimeCalendar field list never actually named a
    // timezone column (only country_code/holiday_dates/standard_business_hours)
    // - a real gap between §5's own assumption and §2.1's literal schema.
    // Added here, additively, rather than silently defaulting every tenant
    // to UTC forever. Nullable + a UTC default: existing rows (none yet in
    // any real deployment) and future tenant-wide default calendars that
    // don't set one explicitly still get well-defined scheduling behavior.
    await queryRunner.query(
      `ALTER TABLE org.working_time_calendars ADD COLUMN timezone varchar(50) NOT NULL DEFAULT 'UTC';`,
    );

    // ADR-0017: reuses core.policies (ADR-0012's precedent) rather than a
    // new column/table - the half-life is just another tenant-configurable
    // number, the same shape as the four Module 02 policy types already there.
    await queryRunner.query(`ALTER TABLE core.policies DROP CONSTRAINT policies_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.policies ADD CONSTRAINT policies_type_check CHECK (
        policy_type IN (
          'overtime_rule','break_rule','approval_chain','data_retention','rate_limit',
          'overtime_threshold','rest_period_minimum','max_consecutive_days','union_rule',
          'skill_decay_half_life'
        )
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE org.working_time_calendars DROP COLUMN IF EXISTS timezone;`);
    await queryRunner.query(`ALTER TABLE core.policies DROP CONSTRAINT IF EXISTS policies_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.policies ADD CONSTRAINT policies_type_check CHECK (
        policy_type IN (
          'overtime_rule','break_rule','approval_chain','data_retention','rate_limit',
          'overtime_threshold','rest_period_minimum','max_consecutive_days','union_rule'
        )
      );
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS org.decay_job_runs;`);
  }
}
