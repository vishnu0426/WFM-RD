import { QueryRunner } from 'typeorm';
import { AttendanceRecordGeofenceVerified1700001000000 } from '../../src/database/migrations/1700001000000-AttendanceRecordGeofenceVerified';

/** Same mock-QueryRunner pattern as the Phase 1/2/3 migration specs. */
describe('AttendanceRecordGeofenceVerified1700001000000', () => {
  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    await new AttendanceRecordGeofenceVerified1700001000000().up(queryRunner);
    return statements;
  }

  it('adds a nullable geofence_verified boolean column', async () => {
    const statements = await runUp();
    expect(
      statements.some((s) =>
        /ALTER TABLE attendance_leave\.attendance_record ADD COLUMN geofence_verified boolean/.test(s),
      ),
    ).toBe(true);
  });

  it("extends exception_type's CHECK constraint to include geofence_violation, preserving the original four values", async () => {
    const statements = await runUp();
    const dropped = statements.some((s) => /DROP CONSTRAINT attendance_record_exception_type_check/.test(s));
    const recreated = statements.find(
      (s) => /ADD CONSTRAINT attendance_record_exception_type_check/.test(s) && /CHECK/.test(s),
    );
    expect(dropped).toBe(true);
    expect(recreated).toBeDefined();
    for (const value of ['late', 'early_leave', 'no_show', 'unscheduled_work', 'geofence_violation']) {
      expect(recreated).toContain(`'${value}'`);
    }
  });

  it('down() restores the original four-value constraint and drops the column', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    await new AttendanceRecordGeofenceVerified1700001000000().down(queryRunner);

    const recreated = statements.find(
      (s) => /ADD CONSTRAINT attendance_record_exception_type_check/.test(s) && /CHECK/.test(s),
    );
    expect(recreated).toBeDefined();
    expect(recreated).not.toContain('geofence_violation');
    expect(statements.some((s) => /DROP COLUMN IF EXISTS geofence_verified/.test(s))).toBe(true);
  });
});
