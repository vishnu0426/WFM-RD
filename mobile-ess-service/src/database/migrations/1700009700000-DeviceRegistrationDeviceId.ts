import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 11 Gap 2 (docs/adr/0154's disclosed judgment call, closed here):
 * the original DDL's `(tenant_id, employee_id, device_type)` unique
 * constraint meant a second same-platform device silently overwrote the
 * first's push token. `mobile-app/src/lib/deviceId.ts` already mints and
 * persists a stable per-install id (used by `syncOfflineActions`) - this
 * migration adds the same identifier here and widens the key to
 * `(tenant_id, employee_id, device_type, device_id)`, so one employee with
 * two iPhones (or an iPhone + an iPad) gets two independent rows instead of
 * one clobbering the other.
 *
 * `device_id NOT NULL` with no default: every row created after this
 * migration must supply one (`RegisterDeviceRequestDto.deviceId`, now
 * required) - there is no pre-existing production data to backfill in this
 * environment, so a hard `NOT NULL` is added directly rather than a
 * nullable-then-backfilled two-step migration.
 */
export class DeviceRegistrationDeviceId1700009700000 implements MigrationInterface {
  name = 'DeviceRegistrationDeviceId1700009700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE mobile_ess.device_registration
      DROP CONSTRAINT device_registration_tenant_employee_device_type_unique;
    `);
    await queryRunner.query(`
      ALTER TABLE mobile_ess.device_registration
      ADD COLUMN device_id varchar NOT NULL DEFAULT '';
    `);
    await queryRunner.query(`
      ALTER TABLE mobile_ess.device_registration
      ALTER COLUMN device_id DROP DEFAULT;
    `);
    await queryRunner.query(`
      ALTER TABLE mobile_ess.device_registration
      ADD CONSTRAINT device_registration_tenant_employee_device_type_device_id_unique
      UNIQUE (tenant_id, employee_id, device_type, device_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE mobile_ess.device_registration
      DROP CONSTRAINT device_registration_tenant_employee_device_type_device_id_unique;
    `);
    await queryRunner.query(`ALTER TABLE mobile_ess.device_registration DROP COLUMN device_id;`);
    await queryRunner.query(`
      ALTER TABLE mobile_ess.device_registration
      ADD CONSTRAINT device_registration_tenant_employee_device_type_unique
      UNIQUE (tenant_id, employee_id, device_type);
    `);
  }
}
