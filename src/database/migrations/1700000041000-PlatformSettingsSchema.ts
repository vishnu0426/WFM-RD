import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform Settings gap-fix: two genuinely platform-wide (not per-tenant)
 * tables — `platform_settings` (a singleton row: SMTP fallback + security
 * baseline) and `platform_feature_flag_defaults` (a default `enabled` per
 * `flag_key`). Same "intentionally no RLS" posture as `core.permissions`
 * (see `1700000000000-InitialSchema.ts`'s own comment to that effect) —
 * neither table has a `tenant_id` column, so there is no row-security
 * boundary to enforce; access is gated entirely at the application layer
 * (`PlatformSettingsController`'s hard `platform_admin` role check), the
 * same posture `core.signing_keys` (ADR-0024) already uses for global
 * reference data.
 */
export class PlatformSettingsSchema1700000041000 implements MigrationInterface {
  name = 'PlatformSettingsSchema1700000041000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.platform_settings (
        id                              uuid NOT NULL,
        smtp_host                       varchar(255),
        smtp_port                       integer,
        smtp_username                   varchar(255),
        smtp_password                   text,
        smtp_from_address               varchar(255),
        smtp_use_tls                    boolean NOT NULL DEFAULT true,
        password_min_length_floor       integer,
        password_require_uppercase      boolean NOT NULL DEFAULT false,
        password_require_number         boolean NOT NULL DEFAULT false,
        password_require_symbol         boolean NOT NULL DEFAULT false,
        password_expiry_days_ceiling    integer,
        session_timeout_ceiling_minutes integer,
        mfa_required                    boolean NOT NULL DEFAULT false,
        created_at                      timestamptz NOT NULL DEFAULT now(),
        updated_at                      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE core.platform_feature_flag_defaults (
        flag_key    varchar(100) NOT NULL,
        enabled     boolean NOT NULL DEFAULT false,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (flag_key)
      );
    `);

    // Intentionally no RLS on either table — see this migration's own doc comment.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.platform_settings TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.platform_feature_flag_defaults TO agno_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.platform_feature_flag_defaults;`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.platform_settings;`);
  }
}
