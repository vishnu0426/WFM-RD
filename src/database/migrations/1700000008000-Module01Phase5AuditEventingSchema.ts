import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 01 Phase 5 — the transactional outbox for §4's `AuditEvent`/
 * `PolicyChanged` NATS events (`core.outbox_events`), the `core`-schema
 * counterpart to Module 02's `org.outbox_events` (ADR-0019). Deliberately a
 * separate table, not a shared one - each module owns its own schema
 * (`core` vs `org`) and, by extension, its own outbox, consistent with the
 * no-cross-module-table-access rule already established (§2.1's
 * `scope_org_unit_id` doc comment, ADR-0021). See docs/phase-5-design-doc.md
 * and ADR-0039.
 */
export class Module01Phase5AuditEventingSchema1700000008000 implements MigrationInterface {
  name = 'Module01Phase5AuditEventingSchema1700000008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const platformAdminExpr = `current_setting('app.is_platform_admin', true) = 'true'`;

    await queryRunner.query(`
      CREATE TABLE core.outbox_events (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL REFERENCES core.tenants(id),
        subject       varchar(255) NOT NULL,
        payload       jsonb NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        published_at  timestamptz,
        attempts      integer NOT NULL DEFAULT 0,
        last_error    text
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_outbox_events_tenant_id_published_at ON core.outbox_events (tenant_id, published_at);`,
    );
    // The publisher's poll query is cross-tenant (no single tenant to scope
    // to - see CoreOutboxPublisherService) and filters unpublished rows
    // regardless of tenant, so it also needs an index that doesn't lead
    // with tenant_id (same reasoning as Module 02's identical index).
    await queryRunner.query(`
      CREATE INDEX idx_outbox_events_published_at_null ON core.outbox_events (created_at) WHERE published_at IS NULL;
    `);

    // The publisher runs as a platform-admin session (ADR-0019's escape
    // hatch, already established for core.tenants via ADR-0007) since one
    // poll batch spans events from every tenant, not one.
    await queryRunner.query(`ALTER TABLE core.outbox_events ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON core.outbox_events FOR ALL
      USING (${platformAdminExpr} OR tenant_id = ${tenantIdExpr})
      WITH CHECK (${platformAdminExpr} OR tenant_id = ${tenantIdExpr});
    `);
    // No DELETE - published events are a durable record of what was sent,
    // same append-only posture as audit_log.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.outbox_events TO agno_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.outbox_events;`);
  }
}
