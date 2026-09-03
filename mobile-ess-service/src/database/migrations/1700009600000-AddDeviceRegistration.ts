import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 11 Phase 5 (§2.1, docs/adr/0154): `DeviceRegistration`'s field
 * set, direct template of `1700009500000-InitialMobileEssSchema.ts`'s own
 * shape (varchar+CHECK enums, `app.current_tenant_id` RLS, ADR-0002/0003).
 *
 * Unlike `offline_action_queue.id`, `id` here DOES default to
 * `gen_random_uuid()` - the real upsert key is the composite UNIQUE
 * constraint below, not `id` (ADR-0154). `agno_mobile_ess_app` gets
 * SELECT/INSERT/UPDATE, no DELETE - a dead push token is a soft
 * `active = false` UPDATE (`PushDispatchService`), never a deleted row,
 * same never-hard-delete posture `offline_action_queue` already has.
 */
export class AddDeviceRegistration1700009600000 implements MigrationInterface {
  name = 'AddDeviceRegistration1700009600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      CREATE TABLE mobile_ess.device_registration (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        employee_id         uuid NOT NULL,
        device_type         varchar(10) NOT NULL,
        push_token          varchar NOT NULL,
        app_version         varchar(50) NOT NULL,
        biometric_enrolled  boolean NOT NULL DEFAULT false,
        active              boolean NOT NULL DEFAULT true,
        last_active_at      timestamptz NOT NULL,
        created_at          timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT device_registration_device_type_check
          CHECK (device_type IN ('ios', 'android')),
        CONSTRAINT device_registration_tenant_employee_device_type_unique
          UNIQUE (tenant_id, employee_id, device_type)
      );
    `);
    // The push-dispatch hot read: "this employee's registered devices."
    // The UNIQUE constraint above already provides an index usable for
    // exact-tuple lookups, but a dedicated (tenant_id, employee_id) index
    // also serves the "all of this employee's devices, any device_type"
    // scan PushDispatchService actually runs.
    await queryRunner.query(`
      CREATE INDEX idx_device_registration_tenant_employee
      ON mobile_ess.device_registration (tenant_id, employee_id);
    `);

    await queryRunner.query(`ALTER TABLE mobile_ess.device_registration ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON mobile_ess.device_registration FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON mobile_ess.device_registration TO agno_mobile_ess_app;`);
    // The initial migration's `REVOKE ALL ... IN SCHEMA` only covered
    // tables that existed at the time it ran - Postgres does not apply
    // that retroactively to tables created later, so this table needs its
    // own explicit REVOKE to match the schema's established posture.
    await queryRunner.query(`REVOKE ALL ON mobile_ess.device_registration FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS mobile_ess.device_registration;`);
  }
}
