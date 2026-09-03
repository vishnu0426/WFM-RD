import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Attendance & Leave Manager Views phase, §4: "Acknowledge" and "Dismiss as
 * not relevant" are two distinct manager judgments that both call
 * `acknowledgeAbsencePattern` - `outcome` is what tells them apart.
 * Constrained to the same two values `AcknowledgeAbsencePatternDto`
 * validates, same reasoning as `attendance_record_exception_type_check`
 * (`1700001000000-AttendanceRecordGeofenceVerified.ts`): an explicit list
 * of allowed values needs a real CHECK constraint, not just a TS-side
 * validator.
 */
export class AbsencePatternOutcome1700001300000 implements MigrationInterface {
  name = 'AbsencePatternOutcome1700001300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE attendance_leave.absence_pattern ADD COLUMN outcome varchar;
    `);
    await queryRunner.query(`
      ALTER TABLE attendance_leave.absence_pattern ADD CONSTRAINT absence_pattern_outcome_check
        CHECK (outcome IS NULL OR outcome IN ('acknowledged', 'dismissed'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE attendance_leave.absence_pattern DROP CONSTRAINT IF EXISTS absence_pattern_outcome_check;
    `);
    await queryRunner.query(`
      ALTER TABLE attendance_leave.absence_pattern DROP COLUMN IF EXISTS outcome;
    `);
  }
}
