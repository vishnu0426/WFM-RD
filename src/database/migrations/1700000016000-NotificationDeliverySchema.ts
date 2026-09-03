import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise readiness audit (2026-08-18), GAP-05, P1: `src/modules/notification/`
 * has only ever contained `NotificationPreference` (who wants what, on which
 * channel) - nothing anywhere in this repository has ever actually sent a
 * notification. `core.notification_preferences` (`1700000000000-InitialSchema.ts:304-330`)
 * is read by nothing.
 *
 * Fix: a real, minimal delivery engine. `core.notification_delivery` is the
 * durable queue `NotificationDeliveryDispatcherService` drains - same shape
 * as the outbox tables already proven in this codebase
 * (`org.outbox_events`/`core.outbox_events`/`core.webhook_deliveries`),
 * including the `claimed_at` lease + claimable partial index pattern those
 * three needed retrofitted after the fact (GAP-14, this same audit) - built
 * claim-safe from day one here instead.
 */
export class NotificationDeliverySchema1700000016000 implements MigrationInterface {
  name = 'NotificationDeliverySchema1700000016000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const platformAdminExpr = `current_setting('app.is_platform_admin', true) = 'true'`;

    await queryRunner.query(`
      CREATE TABLE core.notification_delivery (
        id            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        user_id       uuid NOT NULL,
        channel       varchar(20) NOT NULL,
        event_type    varchar(100) NOT NULL,
        payload       jsonb NOT NULL,
        status        varchar(20) NOT NULL DEFAULT 'pending',
        created_at    timestamptz NOT NULL DEFAULT now(),
        sent_at       timestamptz,
        claimed_at    timestamptz,
        attempts      integer NOT NULL DEFAULT 0,
        last_error    text,
        PRIMARY KEY (id),
        CONSTRAINT notification_delivery_channel_check
          CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
        CONSTRAINT notification_delivery_status_check
          CHECK (status IN ('pending', 'sent', 'failed', 'skipped'))
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_notification_delivery_tenant_user
      ON core.notification_delivery (tenant_id, user_id, created_at DESC);
    `);

    // The dispatcher's own claim query filter - without this, the claim
    // UPDATE's subquery falls back to a full-table scan as the delivered
    // backlog grows (same fix as GAP-14's `idx_org_outbox_events_claimable`).
    await queryRunner.query(`
      CREATE INDEX idx_notification_delivery_claimable ON core.notification_delivery (created_at)
      WHERE status = 'pending';
    `);

    // Same "publisher runs as a platform-admin session" shape as
    // `core.outbox_events`/`org.outbox_events` (`1700000008000`/
    // `1700000003000`) - one dispatcher tick spans every tenant's pending
    // deliveries, not one, so the policy itself must carry the
    // platform-admin escape hatch (this table has no separate migrator-pool
    // provider the way shift-marketplace-service's outbox does).
    await queryRunner.query(`ALTER TABLE core.notification_delivery ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON core.notification_delivery FOR ALL
      USING (${platformAdminExpr} OR tenant_id = ${tenantIdExpr})
      WITH CHECK (${platformAdminExpr} OR tenant_id = ${tenantIdExpr});
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE ON core.notification_delivery TO agno_app;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.notification_delivery;`);
  }
}
