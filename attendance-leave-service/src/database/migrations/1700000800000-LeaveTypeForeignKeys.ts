import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 06 Phase 3: closes a gap in Phase 1's own migration. `leave_type`
 * is owned by this same schema (not a cross-module id like
 * `scheduled_shift_id`/`accrual_policy_id`), so `leave_balance.leave_type_id`
 * and `leave_request.leave_type_id` should have gotten real
 * `REFERENCES leave_type (id)` foreign keys under the exact same reasoning
 * ADR-0075 later applied to `attendance_ingestion_event.attendance_record_id`
 * - both tables are owned by this migration, so ADR-0052/0073's "no FK
 * across schemas" discipline never applied here. Phase 1 missed it; this
 * migration adds it as a normal additive `ALTER TABLE`, not a rewrite of
 * the already-applied Phase 1 migration (never edit a migration once
 * another migration has stacked on top of it).
 *
 * Directly load-bearing for Phase 3's `LeaveRequestService.requestLeave`:
 * without this FK, a request submitted against a `leaveTypeId` that
 * doesn't exist would silently write a `LeaveRequest`/increment a
 * `LeaveBalance` for a leave type nobody defined - the FK makes that
 * structurally impossible, the same "catch an application bug" case
 * ADR-0075 already made for the ledger table.
 */
export class LeaveTypeForeignKeys1700000800000 implements MigrationInterface {
  name = 'LeaveTypeForeignKeys1700000800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE attendance_leave.leave_balance
      ADD CONSTRAINT leave_balance_leave_type_id_fkey
      FOREIGN KEY (leave_type_id) REFERENCES attendance_leave.leave_type (id);
    `);
    await queryRunner.query(`
      ALTER TABLE attendance_leave.leave_request
      ADD CONSTRAINT leave_request_leave_type_id_fkey
      FOREIGN KEY (leave_type_id) REFERENCES attendance_leave.leave_type (id);
    `);
    // Postgres does not auto-index FK columns; both tables' existing
    // indexes lead with (tenant_id, employee_id), neither covers a
    // leave_type_id-only lookup or the FK's own referential-integrity
    // check at scale.
    await queryRunner.query(`
      CREATE INDEX idx_leave_balance_leave_type_id ON attendance_leave.leave_balance (leave_type_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_leave_request_leave_type_id ON attendance_leave.leave_request (leave_type_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS attendance_leave.idx_leave_request_leave_type_id;`);
    await queryRunner.query(`DROP INDEX IF EXISTS attendance_leave.idx_leave_balance_leave_type_id;`);
    await queryRunner.query(
      `ALTER TABLE attendance_leave.leave_request DROP CONSTRAINT IF EXISTS leave_request_leave_type_id_fkey;`,
    );
    await queryRunner.query(
      `ALTER TABLE attendance_leave.leave_balance DROP CONSTRAINT IF EXISTS leave_balance_leave_type_id_fkey;`,
    );
  }
}
