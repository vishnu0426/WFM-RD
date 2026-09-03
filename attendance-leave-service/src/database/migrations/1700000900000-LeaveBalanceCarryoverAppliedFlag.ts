import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 06 Phase 7 (§5.2, ADR-0080): `carryover_applied` is the rollover
 * job's own idempotency marker - a successor `LeaveBalance` period gets
 * its (possibly zero) carryover computed and applied at most once. Unlike
 * `carryover_days_in = 0`, which is also the legitimate *result* of
 * computing a zero carryover (nothing left to carry, or the leave type has
 * no carryover rule configured), this column distinguishes "evaluated,
 * result was zero" from "never evaluated" - without it, a period with a
 * genuinely-zero carryover would be re-queried by the rollover job forever
 * instead of being recognized as done.
 *
 * The partial index matches the rollover job's own `WHERE
 * carryover_applied = false` predicate exactly - the query naturally
 * shrinks to nothing as periods get processed, so a partial index (rather
 * than an index over the whole, mostly-`true`-eventually table) stays
 * small and useful for the life of the table.
 */
export class LeaveBalanceCarryoverAppliedFlag1700000900000 implements MigrationInterface {
  name = 'LeaveBalanceCarryoverAppliedFlag1700000900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE attendance_leave.leave_balance
      ADD COLUMN carryover_applied boolean NOT NULL DEFAULT false;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_leave_balance_carryover_pending
      ON attendance_leave.leave_balance (tenant_id)
      WHERE carryover_applied = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS attendance_leave.idx_leave_balance_carryover_pending;`);
    await queryRunner.query(`ALTER TABLE attendance_leave.leave_balance DROP COLUMN IF EXISTS carryover_applied;`);
  }
}
