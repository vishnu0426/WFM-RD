import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes a set of BACKEND GAP items surfaced by the frontend prototype's
 * Roles Setup screen: `core.roles` had no `description`, no `status`
 * (active/disabled toggle), no `organization_id` (which org this role is
 * scoped/visible to for display purposes), and no `is_default` (whether new
 * users get this role automatically) - the screen has fields for all four
 * that this schema simply had nowhere to persist.
 *
 * `status` is a plain `varchar(20)` with a TS enum on top (`RoleStatus`),
 * matching this codebase's existing convention for simple enums (e.g.
 * `core.users.status`/`UserStatus`, `org.employees.status`/`EmployeeStatus`)
 * rather than a Postgres ENUM type. `organization_id` intentionally has no
 * FK constraint, mirroring how `core.user_roles.scope_org_unit_id` already
 * references Module 02's OrgUnit loosely (no cross-module FK by bounded-
 * context design, per that entity's own doc comment).
 */
export class RolesManagementFields1700000025000 implements MigrationInterface {
  name = 'RolesManagementFields1700000025000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.roles
        ADD COLUMN description     text,
        ADD COLUMN status          varchar(20) NOT NULL DEFAULT 'active',
        ADD COLUMN organization_id uuid,
        ADD COLUMN is_default      boolean NOT NULL DEFAULT false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.roles
        DROP COLUMN description,
        DROP COLUMN status,
        DROP COLUMN organization_id,
        DROP COLUMN is_default;
    `);
  }
}
