import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `intraday.ingestion_credential` - replaces the `INTRADAY_WEBHOOK_SECRETS`
 * env-var stopgap `HmacSignatureGuard` has used since Phase 1 with a real
 * per-tenant, Vault-backed secret store. See `IngestionCredential`'s own
 * doc comment (`src/ingestion-credentials/entities/ingestion-credential.entity.ts`)
 * for why a tenant can hold more than one `active` row (rotation without
 * downtime) and why the secret itself never lives in this table.
 */
export class IngestionCredentialSchema1700000800000 implements MigrationInterface {
  name = 'IngestionCredentialSchema1700000800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE intraday.ingestion_credential (
        id                uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        secret_reference  varchar NOT NULL,
        label             varchar(200),
        status            varchar(20) NOT NULL DEFAULT 'active',
        created_at        timestamptz NOT NULL DEFAULT now(),
        revoked_at        timestamptz,
        CONSTRAINT ingestion_credential_status_check CHECK (status IN ('active', 'revoked')),
        CONSTRAINT ingestion_credential_revoked_at_required CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
        PRIMARY KEY (id)
      );
    `);
    // HmacSignatureGuard's own access pattern: "every active credential for this tenant," on every inbound ingestion request.
    await queryRunner.query(`
      CREATE INDEX idx_ingestion_credential_tenant_status ON intraday.ingestion_credential (tenant_id, status);
    `);

    await queryRunner.query(`ALTER TABLE intraday.ingestion_credential ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON intraday.ingestion_credential FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
    `);

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON intraday.ingestion_credential TO agno_intraday_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS intraday.ingestion_credential;`);
  }
}
