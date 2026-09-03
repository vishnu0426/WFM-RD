import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Attendance & Leave Manager Views phase, §2: the manager approval queue's
 * "required comment field on reject" - `decisionReason` was never a column
 * on `leave_request` before this phase, since `decideLeaveRequest` had no
 * caller-facing UI to require it from until now.
 */
export class LeaveRequestDecisionReason1700001200000 implements MigrationInterface {
  name = 'LeaveRequestDecisionReason1700001200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE attendance_leave.leave_request ADD COLUMN decision_reason text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE attendance_leave.leave_request DROP COLUMN IF EXISTS decision_reason;
    `);
  }
}
