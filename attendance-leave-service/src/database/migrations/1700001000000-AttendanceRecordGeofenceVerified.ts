import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 11 Phase 6 (§5b, docs/adr/0155): `geofence_verified` is
 * mobile-ess-service's own already-computed verification outcome
 * (`GeofenceVerificationService.evaluate`), recorded as-is here - this
 * service never recomputes it. `exception_type`'s CHECK constraint
 * (`1700000600000-InitialAttendanceLeaveSchema.ts:46-47`) must be dropped
 * and recreated to add `'geofence_violation'` - it lists allowed values
 * explicitly, so a new `AttendanceExceptionType` value needs a real
 * migration, not just the TS enum change.
 */
export class AttendanceRecordGeofenceVerified1700001000000 implements MigrationInterface {
  name = 'AttendanceRecordGeofenceVerified1700001000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE attendance_leave.attendance_record ADD COLUMN geofence_verified boolean;
    `);

    await queryRunner.query(`
      ALTER TABLE attendance_leave.attendance_record DROP CONSTRAINT attendance_record_exception_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE attendance_leave.attendance_record ADD CONSTRAINT attendance_record_exception_type_check
        CHECK (exception_type IS NULL OR exception_type IN (
          'late', 'early_leave', 'no_show', 'unscheduled_work', 'geofence_violation'
        ));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE attendance_leave.attendance_record DROP CONSTRAINT attendance_record_exception_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE attendance_leave.attendance_record ADD CONSTRAINT attendance_record_exception_type_check
        CHECK (exception_type IS NULL OR exception_type IN ('late', 'early_leave', 'no_show', 'unscheduled_work'));
    `);
    await queryRunner.query(`ALTER TABLE attendance_leave.attendance_record DROP COLUMN IF EXISTS geofence_verified;`);
  }
}
