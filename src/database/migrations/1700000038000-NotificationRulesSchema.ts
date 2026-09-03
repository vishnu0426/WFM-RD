import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * System Configuration gap-fix: `core.notification_preferences` is per-user
 * only (`findForUser`) — there was no tenant-wide "when event X fires, is
 * channel Y on by default" concept anywhere, and nothing lets a tenant
 * admin create a preference row today except the seed script. This table is
 * that tenant-wide default, consulted by `NotificationService.enqueue` only
 * for a (user, eventType, channel) combination the user has no explicit
 * `NotificationPreference` row for.
 */
export class NotificationRulesSchema1700000038000 implements MigrationInterface {
  name = 'NotificationRulesSchema1700000038000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      CREATE TABLE core.notification_rules (
        id            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        event_type    varchar(100) NOT NULL,
        channel       varchar(20) NOT NULL,
        enabled       boolean NOT NULL DEFAULT true,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT notification_rules_channel_check
          CHECK (channel IN ('email', 'sms', 'push', 'in_app'))
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_notification_rules_tenant_id ON core.notification_rules (tenant_id);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_notification_rules_tenant_event_channel
      ON core.notification_rules (tenant_id, event_type, channel);
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_notification_rules_updated_at BEFORE UPDATE ON core.notification_rules
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    await queryRunner.query(`ALTER TABLE core.notification_rules ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON core.notification_rules FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON core.notification_rules TO agno_app;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.notification_rules;`);
  }
}
