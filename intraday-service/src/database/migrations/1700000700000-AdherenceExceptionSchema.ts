import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `intraday.adherence_exception` - see `AdherenceException`'s own doc
 * comment (`src/adherence/entities/adherence-exception.entity.ts`) for the
 * full rationale: one row per completed non-adherent segment, with the
 * same `open`/`acknowledged`/`resolved` workflow shape `alert` already
 * established (`AlertSchema`, 1700000300000). Not partitioned like
 * `adherence_event` - exceptions are a small fraction of raw events by
 * construction (only nonzero-deviation segments), same "comparatively
 * low-volume table" reasoning `AlertSchema`'s own doc comment gives for
 * not partitioning `alert`.
 */
export class AdherenceExceptionSchema1700000700000 implements MigrationInterface {
  name = 'AdherenceExceptionSchema1700000700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE intraday.adherence_exception (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        employee_id         uuid NOT NULL,
        activity            varchar(64) NOT NULL,
        scheduled_activity  varchar(64),
        started_at          timestamptz NOT NULL,
        ended_at            timestamptz NOT NULL,
        deviation_seconds   integer NOT NULL,
        status              varchar(20) NOT NULL DEFAULT 'open',
        acknowledged_by     uuid,
        acknowledged_at     timestamptz,
        resolution_notes    varchar(500),
        resolved_at         timestamptz,
        created_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT adherence_exception_status_check CHECK (status IN ('open', 'acknowledged', 'resolved')),
        CONSTRAINT adherence_exception_deviation_seconds_check CHECK (deviation_seconds >= 0),
        CONSTRAINT adherence_exception_ended_after_started_check CHECK (ended_at >= started_at),
        CONSTRAINT adherence_exception_resolution_notes_required CHECK (status <> 'resolved' OR resolution_notes IS NOT NULL),
        PRIMARY KEY (id)
      );
    `);
    // The list-view's own access pattern: "open/acknowledged exceptions for this tenant, newest first" (mirrors idx on alert).
    await queryRunner.query(`
      CREATE INDEX idx_adherence_exception_tenant_status ON intraday.adherence_exception (tenant_id, status, started_at DESC);
    `);
    // A per-employee scorecard's own access pattern: "this employee's exceptions over a date range."
    await queryRunner.query(`
      CREATE INDEX idx_adherence_exception_tenant_employee ON intraday.adherence_exception (tenant_id, employee_id, started_at DESC);
    `);

    await queryRunner.query(`ALTER TABLE intraday.adherence_exception ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON intraday.adherence_exception FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
    `);

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON intraday.adherence_exception TO agno_intraday_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS intraday.adherence_exception;`);
  }
}
