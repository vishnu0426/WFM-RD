import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 01 Phase 6 (§3.2's "webhook signing secrets" - see
 * `OAuthController.register`'s own forward-reference comment). Two tables:
 *
 * `core.webhook_subscriptions` - a tenant's registered delivery endpoints,
 * standard closed tenant isolation (same RLS shape as `webauthn_credentials`)
 * since subscription CRUD always happens within one bound tenant context.
 *
 * `core.webhook_deliveries` - one row per (subscription, event) delivery
 * attempt, the durable queue `WebhookDeliveryDispatcherService` drains -
 * same cross-tenant-batch-read RLS shape as `core.outbox_events`/
 * `core.pending_audit_events` (platform-admin escape hatch), since the
 * dispatcher polls across every tenant's pending deliveries in one tick.
 *
 * See docs/phase-6-design-doc.md and ADR-0046.
 */
export class Module01Phase6WebhookSchema1700000010000 implements MigrationInterface {
  name = 'Module01Phase6WebhookSchema1700000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const platformAdminExpr = `current_setting('app.is_platform_admin', true) = 'true'`;

    await queryRunner.query(`
      CREATE TABLE core.webhook_subscriptions (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL REFERENCES core.tenants(id),
        url                  varchar(2048) NOT NULL,
        description          varchar(255),
        -- Plaintext, deliberately NOT a one-way hash: unlike a password or
        -- OAuth client secret (verified by comparing a caller-presented
        -- value against a hash), a webhook signing secret must be read back
        -- by this platform on every delivery to compute that delivery's
        -- HMAC - a one-way hash can't be un-hashed to sign anything. A real
        -- deployment should encrypt this column at rest via a KMS-backed
        -- envelope scheme (same flagged gap as ADR-0024's signing-key
        -- private key storage) - not implemented here, see the readiness
        -- checklist.
        secret               varchar(255) NOT NULL,
        subscribed_subjects  text[] NOT NULL,
        is_active            boolean NOT NULL DEFAULT true,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_webhook_subscriptions_tenant_id ON core.webhook_subscriptions (tenant_id);`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_webhook_subscriptions_updated_at BEFORE UPDATE ON core.webhook_subscriptions
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);
    await queryRunner.query(`ALTER TABLE core.webhook_subscriptions ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON core.webhook_subscriptions FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.webhook_subscriptions TO agno_app;`);

    await queryRunner.query(`
      CREATE TABLE core.webhook_deliveries (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL REFERENCES core.tenants(id),
        subscription_id  uuid NOT NULL REFERENCES core.webhook_subscriptions(id),
        subject          varchar(255) NOT NULL,
        payload          jsonb NOT NULL,
        status           varchar(20) NOT NULL DEFAULT 'pending',
        attempts         integer NOT NULL DEFAULT 0,
        last_error       text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        delivered_at     timestamptz
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_webhook_deliveries_tenant_id_status ON core.webhook_deliveries (tenant_id, status);`,
    );
    // Cross-tenant poll query (the dispatcher, like the outbox publisher,
    // has no single tenant to scope to) - same reasoning as
    // idx_outbox_events_published_at_null.
    await queryRunner.query(`
      CREATE INDEX idx_webhook_deliveries_pending ON core.webhook_deliveries (created_at) WHERE status = 'pending';
    `);
    await queryRunner.query(`ALTER TABLE core.webhook_deliveries ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON core.webhook_deliveries FOR ALL
      USING (${platformAdminExpr} OR tenant_id = ${tenantIdExpr})
      WITH CHECK (${platformAdminExpr} OR tenant_id = ${tenantIdExpr});
    `);
    // No DELETE - a delivery row is a durable record of what was attempted,
    // same append-mostly posture as core.outbox_events.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.webhook_deliveries TO agno_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.webhook_deliveries;`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.webhook_subscriptions;`);
  }
}
