import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Expands `org.employees` with the personal/contact/comp fields the
 * reference "Profile" screen asks for that this schema didn't have yet —
 * name details, contact info, home address (jsonb, display-only, no query
 * need), supervisor/team-lead flags + the `team_lead_employee_id`
 * self-reference (parallels the existing `manager_employee_id`), Tax ID
 * (SSN — masked at the read layer, see `mask-tax-id.ts`; this table's
 * existing RLS/grant already covers new columns, no policy change needed),
 * wage amount, rank, and job title. Deliberately excludes any "Data Source
 * Agent ID"/"Extension" columns — this platform has no ACD/telephony
 * integration anywhere to back them.
 *
 * Not versioned by `org.fn_employee_history_track()` — wage/rank changes
 * here don't produce a new `employee_history` row, unlike org_unit_id/
 * manager_employee_id/status/cost_center. A disclosed scope cut, not an
 * oversight: extending that trigger for full compensation history is a
 * reasonable follow-up, not bundled into this pass.
 */
export class EmployeeProfileDetails1700000024000 implements MigrationInterface {
  name = 'EmployeeProfileDetails1700000024000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE org.employees
        ADD COLUMN middle_initial              varchar(10),
        ADD COLUMN suffix                       varchar(20),
        ADD COLUMN birth_date                   date,
        ADD COLUMN email                        varchar(320),
        ADD COLUMN desktop_messaging_username   varchar(100),
        ADD COLUMN home_phone                   varchar(30),
        ADD COLUMN work_phone                   varchar(30),
        ADD COLUMN cell_phone                   varchar(30),
        ADD COLUMN home_address                 jsonb,
        ADD COLUMN is_supervisor                boolean NOT NULL DEFAULT false,
        ADD COLUMN is_team_lead                 boolean NOT NULL DEFAULT false,
        ADD COLUMN team_lead_employee_id         uuid,
        ADD COLUMN tax_id                       text,
        ADD COLUMN wage_amount                  numeric(12,2),
        ADD COLUMN "rank"                       integer,
        ADD COLUMN job_title                    varchar(150);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE org.employees
        DROP COLUMN middle_initial,
        DROP COLUMN suffix,
        DROP COLUMN birth_date,
        DROP COLUMN email,
        DROP COLUMN desktop_messaging_username,
        DROP COLUMN home_phone,
        DROP COLUMN work_phone,
        DROP COLUMN cell_phone,
        DROP COLUMN home_address,
        DROP COLUMN is_supervisor,
        DROP COLUMN is_team_lead,
        DROP COLUMN team_lead_employee_id,
        DROP COLUMN tax_id,
        DROP COLUMN wage_amount,
        DROP COLUMN "rank",
        DROP COLUMN job_title;
    `);
  }
}
