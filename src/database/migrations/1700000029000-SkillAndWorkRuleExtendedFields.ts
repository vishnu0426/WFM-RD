import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends `org.skills` with a free-text `description` and a lifecycle
 * `status` (active/disabled - see `SkillStatus`), and `org.work_rules`
 * with the additional pay/OT/VTO limit fields and an effective-dating
 * window the existing `maxConsecutiveDays`/`minRestHours`/`maxWeeklyHours`/
 * `otEligible` set didn't cover. `otEligible` (boolean) is kept as-is
 * alongside the new numeric OT fields for backward compatibility - it is
 * not superseded by `maxOtPerDay`/`maxOtPerWeek`.
 *
 * All new columns are nullable (no backfill data exists for them) except
 * `skills.status`, which defaults every existing row to `'active'`.
 */
export class SkillAndWorkRuleExtendedFields1700000029000 implements MigrationInterface {
  name = 'SkillAndWorkRuleExtendedFields1700000029000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE org.skills
        ADD COLUMN description text,
        ADD COLUMN status      varchar(20) NOT NULL DEFAULT 'active';
    `);

    await queryRunner.query(`
      ALTER TABLE org.work_rules
        ADD COLUMN min_paid_hours              numeric(6,2),
        ADD COLUMN max_ot_per_day              numeric(6,2),
        ADD COLUMN max_ot_per_week             numeric(6,2),
        ADD COLUMN max_vto_per_day             numeric(6,2),
        ADD COLUMN max_vto_per_week            numeric(6,2),
        ADD COLUMN required_pay_period_hours   numeric(6,2),
        ADD COLUMN effective_from              date,
        ADD COLUMN effective_to                date;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE org.work_rules
        DROP COLUMN min_paid_hours,
        DROP COLUMN max_ot_per_day,
        DROP COLUMN max_ot_per_week,
        DROP COLUMN max_vto_per_day,
        DROP COLUMN max_vto_per_week,
        DROP COLUMN required_pay_period_hours,
        DROP COLUMN effective_from,
        DROP COLUMN effective_to;
    `);

    await queryRunner.query(`
      ALTER TABLE org.skills
        DROP COLUMN description,
        DROP COLUMN status;
    `);
  }
}
