import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform Admin onboarding (internal CS/ops console): richer Company
 * Information (`core.tenants`) and Primary Admin (`core.users`) fields,
 * plus tenant-level WFM defaults (`core.tenant_settings`) — the "WFM
 * Configuration" onboarding step. `slug` is deliberately the only
 * NOT NULL/required addition here (every other column is optional detail
 * collected opportunistically) and the only *globally* unique index in
 * this schema — every other uniqueness constraint on `core.tenants`/
 * `core.users` is scoped by `tenant_id`; a tenant slug is a platform-wide
 * identifier (e.g. for a future `slug.agno-wfm.example` subdomain), so it
 * has no tenant to scope within.
 */
export class TenantOnboardingRichFields1700000036000 implements MigrationInterface {
  name = 'TenantOnboardingRichFields1700000036000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.tenants
        ADD COLUMN slug varchar(63),
        ADD COLUMN industry varchar(100),
        ADD COLUMN country varchar(2),
        ADD COLUMN currency varchar(3),
        ADD COLUMN language varchar(10);
    `);
    // Partial unique index (not a plain UNIQUE column constraint) so
    // existing/never-onboarded-through-this-flow tenants with a null slug
    // don't collide with each other - Postgres treats every NULL as
    // distinct under a plain unique index already, but the WHERE clause
    // makes that non-collision explicit and self-documenting.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_tenants_slug ON core.tenants (slug) WHERE slug IS NOT NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE core.users
        ADD COLUMN phone varchar(30),
        ADD COLUMN job_title varchar(100);
    `);

    await queryRunner.query(`
      ALTER TABLE core.tenant_settings
        ADD COLUMN week_start_day varchar(10),
        ADD COLUMN day_boundary time;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.tenant_settings DROP COLUMN IF EXISTS week_start_day, DROP COLUMN IF EXISTS day_boundary;`);
    await queryRunner.query(`ALTER TABLE core.users DROP COLUMN IF EXISTS phone, DROP COLUMN IF EXISTS job_title;`);
    await queryRunner.query(`DROP INDEX IF EXISTS core.uq_tenants_slug;`);
    await queryRunner.query(`
      ALTER TABLE core.tenants
        DROP COLUMN IF EXISTS slug,
        DROP COLUMN IF EXISTS industry,
        DROP COLUMN IF EXISTS country,
        DROP COLUMN IF EXISTS currency,
        DROP COLUMN IF EXISTS language;
    `);
  }
}
