import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two independent, small additions bundled into one migration since neither
 * touches a table the other one owns:
 *
 * 1. `org.employee_groups` gains `organization_id`/`parent_group_id`
 *    (nullable, no DB-level FK - same loose-reference trade-off as
 *    `core.user_roles.scope_org_unit_id`: `organization_id` is a forward-
 *    looking multi-org hook this schema doesn't have a `core.organizations`
 *    table for yet, and `parent_group_id` is a self-reference where a
 *    composite `(tenant_id, id)` FK is possible but deliberately skipped for
 *    now, consistent with how this codebase already treats this class of
 *    reference elsewhere) and `status` (`active`/`disabled`, NOT NULL,
 *    defaulted so every existing row backfills as `active` with no manual
 *    data migration).
 *
 * 2. `org.employee_interactions` was created append-only
 *    (`1700000023000`, `GRANT SELECT, INSERT ... TO agno_app` only) on the
 *    posture that "a note is corrected by adding a new one, never edited."
 *    Product now wants `body` to be patchable (typo/redaction fixes) and a
 *    note to be hard-deletable - `employeeId`/`interactionType`/`createdBy`/
 *    `createdAt` stay immutable in the application layer
 *    (`EmployeeInteractionsService`), this just grants the DB privilege the
 *    app needs to do either. No soft-delete column exists on this table and
 *    none is added here - delete is a real `DELETE`, not a status flip.
 */
export class EmployeeGroupHierarchyAndInteractionMutability1700000028000 implements MigrationInterface {
  name = 'EmployeeGroupHierarchyAndInteractionMutability1700000028000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE org.employee_groups
        ADD COLUMN organization_id uuid,
        ADD COLUMN parent_group_id uuid,
        ADD COLUMN status          varchar(20) NOT NULL DEFAULT 'active';
    `);

    // employee_groups already had `GRANT SELECT, INSERT, UPDATE, DELETE ...`
    // (1700000023000) - new columns are covered by that existing grant, no
    // GRANT statement needed here.

    await queryRunner.query(`GRANT UPDATE, DELETE ON org.employee_interactions TO agno_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE UPDATE, DELETE ON org.employee_interactions FROM agno_app;`);

    await queryRunner.query(`
      ALTER TABLE org.employee_groups
        DROP COLUMN organization_id,
        DROP COLUMN parent_group_id,
        DROP COLUMN status;
    `);
  }
}
