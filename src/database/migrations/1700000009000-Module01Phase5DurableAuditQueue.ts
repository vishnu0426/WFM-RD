import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 01 Phase 5 follow-up — closes the "no durable queue behind NATS"
 * gap the Phase 5 readiness checklist flagged: `AuditEventBatcherService`
 * used to buffer enqueued events in a plain in-memory array, so a process
 * restart between `enqueue` and the next 2-second flush tick lost them
 * silently. `core.pending_audit_events` replaces that in-memory array with
 * a Postgres-backed queue (the same "durable staging table" idea as
 * `core.outbox_events`, ADR-0039, applied one step earlier in the
 * pipeline) — `enqueue` now durably inserts a row before returning, and the
 * flush tick reads/deletes from this table instead of a JS array, so a
 * process crash between those two steps loses nothing. See ADR-0042.
 */
export class Module01Phase5DurableAuditQueue1700000009000 implements MigrationInterface {
  name = 'Module01Phase5DurableAuditQueue1700000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const platformAdminExpr = `current_setting('app.is_platform_admin', true) = 'true'`;

    await queryRunner.query(`
      CREATE TABLE core.pending_audit_events (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL REFERENCES core.tenants(id),
        actor_id       varchar(255),
        actor_type     varchar(50) NOT NULL,
        action         varchar(255) NOT NULL,
        resource_type  varchar(255) NOT NULL,
        resource_id    varchar(255),
        before_state   jsonb,
        after_state    jsonb,
        ai_rationale   jsonb,
        created_at     timestamptz NOT NULL DEFAULT now(),
        attempts       integer NOT NULL DEFAULT 0,
        last_error     text
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_pending_audit_events_tenant_id_created_at ON core.pending_audit_events (tenant_id, created_at);`,
    );
    // The flush tick's poll query is cross-tenant, same reasoning as
    // core.outbox_events' identical second index.
    await queryRunner.query(
      `CREATE INDEX idx_pending_audit_events_created_at ON core.pending_audit_events (created_at);`,
    );

    // The batcher's flush tick runs as a platform-admin session for the
    // same reason CoreOutboxPublisherService does (ADR-0019/ADR-0039) - one
    // poll batch spans events from every tenant, not one.
    await queryRunner.query(`ALTER TABLE core.pending_audit_events ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON core.pending_audit_events FOR ALL
      USING (${platformAdminExpr} OR tenant_id = ${tenantIdExpr})
      WITH CHECK (${platformAdminExpr} OR tenant_id = ${tenantIdExpr});
    `);
    // Unlike audit_log/outbox_events, this is a working queue, not a durable
    // record of what happened - rows are deleted once safely written to
    // audit_log (or handed off to the DLQ), so DELETE/UPDATE are both
    // legitimate here (ADR-0042).
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.pending_audit_events TO agno_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.pending_audit_events;`);
  }
}
