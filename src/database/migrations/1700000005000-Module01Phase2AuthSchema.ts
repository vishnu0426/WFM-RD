import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 01 Phase 2 — Identity core (§8 Phase 2, §5). Adds the five tables
 * OAuth2.1/OIDC token issuance needs that Phase 1's schema didn't anticipate:
 * `oauth_clients` (registered relying parties), `user_credentials` (local
 * password bootstrap - see ADR-0023), `signing_keys` (JWS signing material +
 * rotation, ADR-0024), `authorization_codes` (PKCE code exchange, one-time
 * use), and `refresh_tokens` (rotation + reuse-detection family tracking,
 * ADR-0025). See docs/phase-2-design-doc.md and ADR-0023 through ADR-0028.
 */
export class Module01Phase2AuthSchema1700000005000 implements MigrationInterface {
  name = 'Module01Phase2AuthSchema1700000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -------------------------------------------------------------------
    // oauth_clients — ADR-0028: read-open / write-tenant-gated RLS, the
    // same shape already established for roles/role_permissions. A
    // client_id lookup at POST /oauth/token happens *before* any tenant
    // context can be bound (the client_id is how the tenant is resolved in
    // the first place), so this table cannot use the closed
    // tenant_isolation policy every other table in this migration uses.
    // -------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.oauth_clients (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                   uuid NOT NULL REFERENCES core.tenants(id),
        client_id                   varchar(100) NOT NULL,
        client_secret_hash          varchar(255),
        client_type                 varchar(20) NOT NULL,
        name                        varchar(255) NOT NULL,
        allowed_grant_types         text[] NOT NULL,
        redirect_uris               text[] NOT NULL DEFAULT '{}',
        token_endpoint_auth_method  varchar(30) NOT NULL,
        is_active                   boolean NOT NULL DEFAULT true,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT oauth_clients_type_check CHECK (client_type IN ('confidential','public')),
        CONSTRAINT oauth_clients_secret_matches_type CHECK (
          (client_type = 'public' AND client_secret_hash IS NULL) OR
          (client_type = 'confidential' AND client_secret_hash IS NOT NULL)
        ),
        CONSTRAINT uq_oauth_clients_client_id UNIQUE (client_id)
      );
    `);
    await queryRunner.query(`CREATE INDEX idx_oauth_clients_tenant_id ON core.oauth_clients (tenant_id);`);
    await queryRunner.query(`
      CREATE TRIGGER trg_oauth_clients_updated_at BEFORE UPDATE ON core.oauth_clients
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    // -------------------------------------------------------------------
    // user_credentials — local password bootstrap (ADR-0023). One row per
    // user who has a local password set; a user authenticating solely via
    // an external IdP (Phase 3) never gets one.
    // -------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.user_credentials (
        user_id                 uuid PRIMARY KEY,
        tenant_id                uuid NOT NULL,
        password_hash            varchar(255) NOT NULL,
        password_algorithm       varchar(20) NOT NULL DEFAULT 'bcrypt',
        password_updated_at      timestamptz NOT NULL DEFAULT now(),
        failed_login_attempts    integer NOT NULL DEFAULT 0,
        locked_until             timestamptz,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_user_credentials_tenant_user FOREIGN KEY (tenant_id, user_id)
          REFERENCES core.users(tenant_id, id) ON DELETE CASCADE
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_user_credentials_tenant_id_user_id ON core.user_credentials (tenant_id, user_id);`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_user_credentials_updated_at BEFORE UPDATE ON core.user_credentials
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    // -------------------------------------------------------------------
    // signing_keys — global platform reference data, like `permissions`:
    // not tenant data, so no tenant_id column and no RLS (ADR-0024).
    // Private key material is a plaintext column here as an explicit
    // Phase 2 stand-in for a real KMS/HSM - flagged in the production
    // readiness checklist, not silently implied to be production-safe.
    // -------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.signing_keys (
        kid              varchar(64) PRIMARY KEY,
        algorithm        varchar(10) NOT NULL DEFAULT 'RS256',
        public_key_pem   text NOT NULL,
        private_key_pem  text NOT NULL,
        status           varchar(20) NOT NULL DEFAULT 'active',
        created_at       timestamptz NOT NULL DEFAULT now(),
        retired_at       timestamptz,
        CONSTRAINT signing_keys_status_check CHECK (status IN ('active','retired'))
      );
    `);
    // At most one active signing key at a time (ADR-0024's rotation model).
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_signing_keys_single_active ON core.signing_keys (status) WHERE status = 'active';
    `);

    // -------------------------------------------------------------------
    // authorization_codes — one-time PKCE codes, S256 only (OAuth2.1 forbids
    // `plain` - ADR-0027). Short-lived (service-enforced TTL, ~60s); the
    // code itself is never stored, only its SHA-256 hash.
    // -------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.authorization_codes (
        code_hash              varchar(128) PRIMARY KEY,
        tenant_id                uuid NOT NULL,
        client_id                uuid NOT NULL REFERENCES core.oauth_clients(id) ON DELETE CASCADE,
        user_id                  uuid NOT NULL,
        redirect_uri              text NOT NULL,
        code_challenge            varchar(128) NOT NULL,
        code_challenge_method      varchar(10) NOT NULL DEFAULT 'S256',
        scope                     text NOT NULL DEFAULT '',
        nonce                     varchar(255),
        auth_time                  timestamptz NOT NULL,
        amr                        text[] NOT NULL DEFAULT '{}',
        expires_at                  timestamptz NOT NULL,
        consumed_at                 timestamptz,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT authorization_codes_pkce_s256_only CHECK (code_challenge_method = 'S256'),
        CONSTRAINT fk_authorization_codes_tenant_user FOREIGN KEY (tenant_id, user_id)
          REFERENCES core.users(tenant_id, id) ON DELETE CASCADE
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_authorization_codes_tenant_id_expires_at ON core.authorization_codes (tenant_id, expires_at);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_authorization_codes_tenant_id_client_id ON core.authorization_codes (tenant_id, client_id);`,
    );

    // -------------------------------------------------------------------
    // refresh_tokens — family_id + generation is the reuse-detection
    // mechanism (ADR-0025). Only the hash is stored; Redis holds a
    // short-lived "current generation" pointer per family for the fast
    // path, Postgres is the durable source of truth.
    // -------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.refresh_tokens (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        family_id           uuid NOT NULL,
        generation          integer NOT NULL,
        user_id             uuid NOT NULL,
        client_id           uuid NOT NULL REFERENCES core.oauth_clients(id) ON DELETE CASCADE,
        token_hash           varchar(128) NOT NULL,
        status               varchar(20) NOT NULL DEFAULT 'active',
        amr                  text[] NOT NULL DEFAULT '{}',
        auth_time             timestamptz NOT NULL,
        scope                text NOT NULL DEFAULT '',
        replaced_by_id        uuid REFERENCES core.refresh_tokens(id),
        revoked_at            timestamptz,
        revoked_reason        varchar(50),
        expires_at            timestamptz NOT NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT refresh_tokens_status_check CHECK (status IN ('active','rotated','revoked')),
        CONSTRAINT refresh_tokens_generation_positive CHECK (generation >= 1),
        CONSTRAINT uq_refresh_tokens_token_hash UNIQUE (token_hash),
        CONSTRAINT fk_refresh_tokens_tenant_user FOREIGN KEY (tenant_id, user_id)
          REFERENCES core.users(tenant_id, id) ON DELETE CASCADE
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_refresh_tokens_tenant_id_family_id_generation ON core.refresh_tokens (tenant_id, family_id, generation DESC);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_refresh_tokens_tenant_id_user_id ON core.refresh_tokens (tenant_id, user_id);`,
    );

    // -------------------------------------------------------------------
    // RLS
    // -------------------------------------------------------------------
    for (const table of ['user_credentials', 'authorization_codes', 'refresh_tokens']) {
      await queryRunner.query(`ALTER TABLE core.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON core.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // oauth_clients: ADR-0028 - read-open, write-tenant-gated (mirrors
    // roles/role_permissions' read/write split from the Phase 1 migration).
    await queryRunner.query(`ALTER TABLE core.oauth_clients ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`CREATE POLICY oauth_clients_select ON core.oauth_clients FOR SELECT USING (true);`);
    await queryRunner.query(`
      CREATE POLICY oauth_clients_insert ON core.oauth_clients FOR INSERT WITH CHECK (tenant_id = ${tenantIdExpr});
    `);
    await queryRunner.query(`
      CREATE POLICY oauth_clients_update ON core.oauth_clients FOR UPDATE
      USING (tenant_id = ${tenantIdExpr}) WITH CHECK (tenant_id = ${tenantIdExpr});
    `);
    await queryRunner.query(`
      CREATE POLICY oauth_clients_delete ON core.oauth_clients FOR DELETE USING (tenant_id = ${tenantIdExpr});
    `);

    // signing_keys: intentionally no RLS - global platform reference data,
    // same posture as `permissions` (see that entity's doc comment).

    // -------------------------------------------------------------------
    // Grants. No DELETE on oauth_clients (deactivate via is_active=false,
    // same posture as tenants/policies); DELETE allowed on
    // authorization_codes/refresh_tokens for the (Phase 7) cleanup job -
    // these are not audit-critical rows like audit_log.
    // -------------------------------------------------------------------
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.oauth_clients TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.user_credentials TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.signing_keys TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.authorization_codes TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.refresh_tokens TO agno_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.refresh_tokens;`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.authorization_codes;`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.signing_keys;`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.user_credentials;`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.oauth_clients;`);
  }
}
