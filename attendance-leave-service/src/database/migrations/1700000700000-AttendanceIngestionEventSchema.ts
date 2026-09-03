import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 06 Phase 2 (§3.2, ADR-0075): the idempotency ledger backing
 * `POST .../clock-events`. `UNIQUE (tenant_id, source, source_event_id)` is
 * the actual dedup mechanism - `AttendanceIngestionService` relies on a
 * unique-violation on this constraint to detect a replayed webhook, not an
 * application-level pre-check (same "let the database be the single source
 * of truth for uniqueness" reasoning as every other unique constraint in
 * this platform).
 *
 * `attendance_record_id` is a real same-schema `REFERENCES` (not a plain
 * uuid) - unlike the cross-module ids elsewhere in this schema, both tables
 * are owned by this migration, so ADR-0052/0073's "no FK across schemas"
 * discipline doesn't apply here; a real FK is strictly better (catches an
 * application bug that writes a ledger row for a record that doesn't
 * exist). This FK is exactly why `AttendanceIngestionService` writes the
 * `AttendanceRecord` row and this ledger row in the same transaction
 * (ADR-0075's revised design) - the referenced row must already exist
 * *within that transaction* before the ledger insert runs.
 *
 * No DELETE grant - Phase 1's "no DELETE anywhere in this schema" grant
 * posture holds unchanged for this table too. An earlier draft of this
 * design deleted a ledger row as a compensating action on downstream
 * failure; the revised single-transaction design (ADR-0075) makes that
 * unnecessary - a failed write rolls back the whole transaction, ledger
 * row included, for free.
 */
export class AttendanceIngestionEventSchema1700000700000 implements MigrationInterface {
  name = 'AttendanceIngestionEventSchema1700000700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE attendance_leave.attendance_ingestion_event (
        id                       uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                uuid NOT NULL,
        source                   varchar(20) NOT NULL,
        source_event_id          varchar(255) NOT NULL,
        event_type               varchar(20) NOT NULL,
        attendance_record_id     uuid NOT NULL,
        received_at              timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT attendance_ingestion_event_source_check
          CHECK (source IN ('badge', 'biometric', 'manual', 'mobile_app')),
        CONSTRAINT attendance_ingestion_event_event_type_check
          CHECK (event_type IN ('clock_in', 'clock_out')),
        CONSTRAINT attendance_ingestion_event_attendance_record_id_fkey
          FOREIGN KEY (attendance_record_id) REFERENCES attendance_leave.attendance_record (id),
        CONSTRAINT attendance_ingestion_event_dedup_key
          UNIQUE (tenant_id, source, source_event_id)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_attendance_ingestion_event_attendance_record_id
      ON attendance_leave.attendance_ingestion_event (attendance_record_id);
    `);

    await queryRunner.query(`ALTER TABLE attendance_leave.attendance_ingestion_event ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON attendance_leave.attendance_ingestion_event FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT ON attendance_leave.attendance_ingestion_event TO agno_attendance_leave_app;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS attendance_leave.attendance_ingestion_event;`);
  }
}
