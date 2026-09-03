import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 01 Phase 3 — SCIM 2.0 (§8 Phase 3, §5.3). `core.users` (Phase 1)
 * has no name fields - only `email`. SCIM's core User schema
 * (RFC 7643 §4.1) sends `name.givenName`/`name.familyName` by default from
 * every mainstream IdP connector (Okta, Entra ID, ...), so these two
 * nullable columns are added rather than silently dropping that data on
 * every SCIM provisioning request. Additive, nullable, no backfill needed -
 * every existing row is simply "name unknown," same as before this
 * migration for any caller that doesn't ask for these fields.
 */
export class Module01Phase3ScimUserNameColumns1700000007000 implements MigrationInterface {
  name = 'Module01Phase3ScimUserNameColumns1700000007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.users ADD COLUMN given_name varchar(100);`);
    await queryRunner.query(`ALTER TABLE core.users ADD COLUMN family_name varchar(100);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.users DROP COLUMN IF EXISTS family_name;`);
    await queryRunner.query(`ALTER TABLE core.users DROP COLUMN IF EXISTS given_name;`);
  }
}
