import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Frontend Phase 8 follow-up: adds an optional per-tenant `username` to
 * `core.users` (login-lookup mirrors `PasswordAuthService.authenticate`'s
 * existing email lookup, tried first per `UsersRepository.findByUsername`)
 * and `last_login_at` to `core.user_credentials` (stamped by
 * `PasswordAuthService.authenticate` on a successful local-password login).
 *
 * `username` is nullable (an existing user has none until an admin sets one
 * via `PATCH /v1/users/:id/username`) and, unlike `email`, is NOT
 * lowercase-normalized at the entity layer - the partial unique index below
 * enforces case-insensitive per-tenant uniqueness the same way
 * `uq_users_tenant_id_email` (InitialSchema) does for email, via
 * `lower(username)` rather than relying on the stored value already being
 * lowercase. `WHERE username IS NOT NULL` mirrors how Postgres unique
 * indexes already treat NULL (multiple NULLs never conflict) - stated
 * explicitly here since `lower(NULL)` is itself NULL, which would already
 * behave this way, but the partial predicate keeps the index smaller and
 * the intent unambiguous.
 */
export class UserUsernameAndLastLogin1700000026000 implements MigrationInterface {
  name = 'UserUsernameAndLastLogin1700000026000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.user_credentials
        ADD COLUMN last_login_at timestamptz;
    `);
    await queryRunner.query(`
      ALTER TABLE core.users
        ADD COLUMN username varchar(100);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_users_tenant_id_username_lower ON core.users (tenant_id, lower(username)) WHERE username IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX core.uq_users_tenant_id_username_lower;`);
    await queryRunner.query(`
      ALTER TABLE core.users
        DROP COLUMN username;
    `);
    await queryRunner.query(`
      ALTER TABLE core.user_credentials
        DROP COLUMN last_login_at;
    `);
  }
}
