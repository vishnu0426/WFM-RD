import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes the "UserRole has no groupId" gap the User Access Rights screen's
 * own copy flagged ("Groups attach work rules to employees, not login
 * access"). Adds a second, independent scope axis alongside
 * `scope_org_unit_id`: `scope_group_id`, an opaque reference to
 * `org.employee_groups.id` - no cross-module FK, same bounded-context
 * reasoning `scope_org_unit_id` itself already documents.
 *
 * The two scopes are mutually exclusive (a grant is tenant-wide, OR
 * org-unit-scoped, OR group-scoped - never both at once), enforced by a
 * CHECK constraint rather than left to the application layer, since
 * `AbacService`'s exact-match evaluation (see that class's own doc comment)
 * depends on this invariant: a "true tenant-wide" grant is exactly the
 * rows where *both* scope columns are NULL, which is why
 * `uq_user_roles_tenant_wide`'s WHERE clause below also changes.
 */
export class UserRoleGroupScope1700000030000 implements MigrationInterface {
  name = 'UserRoleGroupScope1700000030000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.user_roles ADD COLUMN scope_group_id uuid;
    `);
    await queryRunner.query(`
      ALTER TABLE core.user_roles
        ADD CONSTRAINT chk_user_roles_scope_exclusive
        CHECK (NOT (scope_org_unit_id IS NOT NULL AND scope_group_id IS NOT NULL));
    `);
    await queryRunner.query(`DROP INDEX core.uq_user_roles_tenant_wide;`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_user_roles_tenant_wide ON core.user_roles (tenant_id, user_id, role_id)
        WHERE scope_org_unit_id IS NULL AND scope_group_id IS NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_user_roles_scoped_group ON core.user_roles (tenant_id, user_id, role_id, scope_group_id)
        WHERE scope_group_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX core.uq_user_roles_scoped_group;`);
    await queryRunner.query(`DROP INDEX core.uq_user_roles_tenant_wide;`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_user_roles_tenant_wide ON core.user_roles (tenant_id, user_id, role_id)
        WHERE scope_org_unit_id IS NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE core.user_roles DROP CONSTRAINT chk_user_roles_scope_exclusive;
    `);
    await queryRunner.query(`
      ALTER TABLE core.user_roles DROP COLUMN scope_group_id;
    `);
  }
}
