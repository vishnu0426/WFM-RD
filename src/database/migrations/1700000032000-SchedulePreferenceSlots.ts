import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * User Management audit GAP-01: `EmployeeSchedulePreference` had only one
 * shift-window (`preferredShiftStart`/`preferredShiftEnd`), never the
 * reference's ranked "First / Second / Third Preference" + "Early / Late"
 * fields. Adds `preference_slots` jsonb (array of `{rank, startTime,
 * endTime, earlyLate}`, at most 3 entries) alongside the existing single
 * window rather than replacing it — existing rows/callers keep working
 * unchanged, the ranked model is additive. `preferred_days_off` (already a
 * `text[]`) needs no migration: Postgres preserves array order round-trip,
 * so it already carries a priority ordering — the gap there was in the
 * frontend not offering reordering, not in the schema.
 */
export class SchedulePreferenceSlots1700000032000 implements MigrationInterface {
  name = 'SchedulePreferenceSlots1700000032000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE org.employee_schedule_preferences
        ADD COLUMN preference_slots jsonb;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE org.employee_schedule_preferences
        DROP COLUMN preference_slots;
    `);
  }
}
