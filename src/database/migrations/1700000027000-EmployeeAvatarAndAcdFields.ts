import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a profile-photo `avatar_url` column plus three ACD/telephony
 * identifiers (`agent_id`, `extension`, `data_source`) to `org.employees`.
 * This explicitly supersedes `1700000024000-EmployeeProfileDetails`'s own
 * documented decision to exclude "Data Source Agent ID"/"Extension" columns
 * for lack of any ACD/telephony integration - a deliberate reversal per the
 * plan author's direction, not an oversight: those columns are now added
 * (still unbacked by any live integration, plain nullable metadata for
 * whenever one exists). All four columns are nullable.
 */
export class EmployeeAvatarAndAcdFields1700000027000 implements MigrationInterface {
  name = 'EmployeeAvatarAndAcdFields1700000027000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE org.employees
        ADD COLUMN avatar_url  text,
        ADD COLUMN agent_id    varchar(100),
        ADD COLUMN extension   varchar(20),
        ADD COLUMN data_source varchar(100);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE org.employees
        DROP COLUMN avatar_url,
        DROP COLUMN agent_id,
        DROP COLUMN extension,
        DROP COLUMN data_source;
    `);
  }
}
