import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.tenant_settings` — one row per tenant (email/SMTP, security policy,
 * general/branding settings). Same tenant-scoped-table shape as
 * `core.notification_delivery` (`1700000016000`): standard RLS
 * tenant-isolation policy, `agno_app` grant. No DELETE grant — this is a
 * singleton settings row per tenant, never removed independently of the
 * tenant itself.
 */
export class TenantSettingsSchema1700000020000 implements MigrationInterface {
  name = 'TenantSettingsSchema1700000020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const platformAdminExpr = `current_setting('app.is_platform_admin', true) = 'true'`;

    await queryRunner.query(`
      CREATE TABLE core.tenant_settings (
        id                          uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                   uuid NOT NULL,
        smtp_host                   varchar(255),
        smtp_port                   integer,
        smtp_username               varchar(255),
        smtp_password               text,
        smtp_from_address           varchar(255),
        smtp_use_tls                boolean NOT NULL DEFAULT true,
        password_min_length         integer NOT NULL DEFAULT 12,
        password_require_uppercase  boolean NOT NULL DEFAULT true,
        password_require_number     boolean NOT NULL DEFAULT true,
        password_require_symbol     boolean NOT NULL DEFAULT false,
        password_expiry_days        integer,
        session_timeout_minutes     integer NOT NULL DEFAULT 60,
        mfa_required                boolean NOT NULL DEFAULT false,
        brand_logo_url              varchar(500),
        timezone                    varchar(100) NOT NULL DEFAULT 'UTC',
        locale                      varchar(20) NOT NULL DEFAULT 'en-US',
        data_retention_days         integer NOT NULL DEFAULT 365,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id)
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_tenant_settings_tenant_id ON core.tenant_settings (tenant_id);
    `);

    await queryRunner.query(`ALTER TABLE core.tenant_settings ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON core.tenant_settings FOR ALL
      USING (${platformAdminExpr} OR tenant_id = ${tenantIdExpr})
      WITH CHECK (${platformAdminExpr} OR tenant_id = ${tenantIdExpr});
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE ON core.tenant_settings TO agno_app;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.tenant_settings;`);
  }
}
