import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 11 Phase 3 (§2.1, docs/adr/0151): `OfflineActionQueue`'s full
 * field set, modeled directly on ADR-0073's shared-database/new-schema/
 * new-role pattern (attendance-leave-service is the closest analog:
 * standard CRUD, no partitioning need). Reuses Module 01's
 * `app.current_tenant_id` RLS convention (ADR-0002) unchanged. Enum-typed
 * columns are `varchar` + `CHECK`, not native Postgres `ENUM` (ADR-0003).
 *
 * `id` has NO `DEFAULT gen_random_uuid()` - it is always client-supplied
 * (the mobile app mints it at queue time) and is this table's real
 * idempotency mechanism (docs/adr/0152). A row is UPDATEd as sync
 * processing resolves it (`status`/`synced_at`/`conflict_details`), never
 * deleted - so `agno_mobile_ess_app` gets SELECT/INSERT/UPDATE, no DELETE,
 * same posture as every other module's own schema.
 */
export class InitialMobileEssSchema1700009500000 implements MigrationInterface {
  name = 'InitialMobileEssSchema1700009500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS mobile_ess;`);

    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      CREATE TABLE mobile_ess.offline_action_queue (
        id                  uuid NOT NULL,
        tenant_id           uuid NOT NULL,
        employee_id         uuid NOT NULL,
        action_type         varchar(30) NOT NULL,
        payload              jsonb NOT NULL,
        status               varchar(20) NOT NULL DEFAULT 'pending_sync',
        created_at_device    timestamptz NOT NULL,
        received_at          timestamptz NOT NULL DEFAULT now(),
        synced_at            timestamptz,
        conflict_details     jsonb,
        geofence_verified    boolean,
        PRIMARY KEY (id),
        CONSTRAINT offline_action_queue_action_type_check
          CHECK (action_type IN ('clock_event', 'leave_request', 'marketplace_claim')),
        CONSTRAINT offline_action_queue_status_check
          CHECK (status IN ('pending_sync', 'synced', 'failed', 'conflict'))
      );
    `);
    // The sync engine's own hot-path read: "give me this employee's
    // not-yet-terminal actions" - and the general tenant-scoped listing
    // access pattern.
    await queryRunner.query(`
      CREATE INDEX idx_offline_action_queue_tenant_employee_status
      ON mobile_ess.offline_action_queue (tenant_id, employee_id, status);
    `);

    await queryRunner.query(`ALTER TABLE mobile_ess.offline_action_queue ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON mobile_ess.offline_action_queue FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    await queryRunner.query(`GRANT USAGE ON SCHEMA mobile_ess TO agno_mobile_ess_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON mobile_ess.offline_action_queue TO agno_mobile_ess_app;`);
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA mobile_ess FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS mobile_ess CASCADE;`);
  }
}
