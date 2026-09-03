import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `self_identification_properties` to `core.tenant_settings`
 * (`1700000020000`) — an ordered jsonb array of `SelfIdentificationProperty`
 * enum keys (`src/modules/tenant-settings/entities/self-identification-property.enum.ts`)
 * the tenant has chosen as the fields an employee must supply to verify
 * their own identity. Same table, same RLS policy, same `agno_app` grant as
 * every other tenant_settings column — no policy/grant change needed here.
 */
export class TenantSettingsSelfIdentification1700000022000 implements MigrationInterface {
  name = 'TenantSettingsSelfIdentification1700000022000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.tenant_settings
      ADD COLUMN self_identification_properties jsonb NOT NULL DEFAULT '[]'::jsonb;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.tenant_settings DROP COLUMN self_identification_properties;
    `);
  }
}
