import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Attendance & Leave Manager Views phase: `GET /v1/attendance/exceptions`
 * (`ListAttendanceExceptionsService`) filters on
 * `tenant_id, employee_id IN (...), exception_type IS NOT NULL, clock_in_at
 * BETWEEN ...` - the existing `idx_attendance_record_tenant_employee_clock_in`
 * index (built for the single-employee self-service endpoint) doesn't cover
 * the `exception_type IS NOT NULL` predicate across many employees. A
 * partial index scoped to non-null exception rows only keeps it small - the
 * large majority of `attendance_record` rows have no exception at all.
 */
export class AttendanceRecordExceptionTypeIndex1700001400000 implements MigrationInterface {
  name = 'AttendanceRecordExceptionTypeIndex1700001400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX idx_attendance_record_tenant_exception_type_clock_in
      ON attendance_leave.attendance_record (tenant_id, exception_type, clock_in_at DESC)
      WHERE exception_type IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS attendance_leave.idx_attendance_record_tenant_exception_type_clock_in;
    `);
  }
}
