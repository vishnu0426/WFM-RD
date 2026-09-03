import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 01 Phase 3 — Enterprise SSO (§8 Phase 3, §5). Adds
 * `tenant_identity_providers` (per-tenant SAML/OIDC federation config,
 * §5.5) and `webauthn_credentials` (§5.4). Also widens `policies_type_check`
 * to add `auth_method_policy` (§5.4's "per-tenant policy on which methods
 * are required vs optional") - the JSONB `Policy.definition` mechanism
 * Phase 1 built specifically so new policy types don't need new tables
 * (docs/adr/0003) is exactly what this reuses.
 *
 * See docs/phase-3-design-doc.md and ADR-0029 (tenant_identity_providers'
 * read-open/write-gated RLS, reusing ADR-0028's pattern for the same
 * structural reason: the SSO callback has to resolve *which* provider a
 * response belongs to before any tenant context is bound).
 */
export class Module01Phase3SsoSchema1700000006000 implements MigrationInterface {
  name = 'Module01Phase3SsoSchema1700000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -------------------------------------------------------------------
    // tenant_identity_providers
    // -------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.tenant_identity_providers (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL REFERENCES core.tenants(id),
        protocol             varchar(10) NOT NULL,
        name                 varchar(100) NOT NULL,
        is_active            boolean NOT NULL DEFAULT true,
        -- OIDC (generic OIDC / Entra ID / Okta / Auth0 / Keycloak / Ping /
        -- OneLogin / Google Workspace / GitHub Enterprise / GitLab / Apple -
        -- all speak this protocol; no per-vendor code, only per-tenant config).
        oidc_discovery_url   text,
        oidc_client_id       varchar(255),
        oidc_client_secret   text,
        -- SAML 2.0 (generic SAML / ADFS / anything issuing SAML assertions).
        saml_entity_id       text,
        saml_sso_url         text,
        saml_slo_url         text,
        saml_certificate     text,
        -- IdP claim/attribute name -> {email, given_name, family_name, groups}.
        attribute_mapping    jsonb NOT NULL DEFAULT '{}',
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT tenant_idp_protocol_check CHECK (protocol IN ('saml','oidc')),
        CONSTRAINT tenant_idp_oidc_fields_check CHECK (
          protocol <> 'oidc' OR (
            oidc_discovery_url IS NOT NULL AND oidc_client_id IS NOT NULL AND oidc_client_secret IS NOT NULL
          )
        ),
        CONSTRAINT tenant_idp_saml_fields_check CHECK (
          protocol <> 'saml' OR (
            saml_entity_id IS NOT NULL AND saml_sso_url IS NOT NULL AND saml_certificate IS NOT NULL
          )
        ),
        CONSTRAINT uq_tenant_idp_tenant_name UNIQUE (tenant_id, name)
      );
    `);
    await queryRunner.query(`CREATE INDEX idx_tenant_idp_tenant_id ON core.tenant_identity_providers (tenant_id);`);
    await queryRunner.query(`
      CREATE TRIGGER trg_tenant_idp_updated_at BEFORE UPDATE ON core.tenant_identity_providers
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    // -------------------------------------------------------------------
    // webauthn_credentials
    // -------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.webauthn_credentials (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        user_id         uuid NOT NULL,
        credential_id   varchar(512) NOT NULL,
        public_key      text NOT NULL,
        counter         integer NOT NULL DEFAULT 0,
        device_type     varchar(20) NOT NULL,
        backed_up       boolean NOT NULL DEFAULT false,
        transports      text[] NOT NULL DEFAULT '{}',
        device_name     varchar(100),
        created_at      timestamptz NOT NULL DEFAULT now(),
        last_used_at    timestamptz,
        CONSTRAINT uq_webauthn_credentials_credential_id UNIQUE (credential_id),
        CONSTRAINT webauthn_credentials_device_type_check CHECK (device_type IN ('singleDevice','multiDevice')),
        CONSTRAINT fk_webauthn_credentials_tenant_user FOREIGN KEY (tenant_id, user_id)
          REFERENCES core.users(tenant_id, id) ON DELETE CASCADE
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_webauthn_credentials_tenant_id_user_id ON core.webauthn_credentials (tenant_id, user_id);`,
    );

    // -------------------------------------------------------------------
    // §5.4: per-tenant policy on which auth methods are required/optional,
    // reusing Phase 1's JSONB policy mechanism (ADR-0003) - no new table.
    // -------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE core.policies DROP CONSTRAINT policies_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.policies ADD CONSTRAINT policies_type_check CHECK (
        policy_type IN ('overtime_rule','break_rule','approval_chain','data_retention','rate_limit','auth_method_policy')
      );
    `);

    // -------------------------------------------------------------------
    // RLS
    // -------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE core.webauthn_credentials ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON core.webauthn_credentials FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    // tenant_identity_providers: ADR-0029 (reuses ADR-0028's shape) - the
    // SSO callback resolves *which* provider a SAMLResponse/OIDC redirect
    // belongs to via its `id` (carried through RelayState/`state`) before
    // any tenant context can be bound, so SELECT must be open.
    await queryRunner.query(`ALTER TABLE core.tenant_identity_providers ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(
      `CREATE POLICY tenant_idp_select ON core.tenant_identity_providers FOR SELECT USING (true);`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_idp_insert ON core.tenant_identity_providers FOR INSERT WITH CHECK (tenant_id = ${tenantIdExpr});
    `);
    await queryRunner.query(`
      CREATE POLICY tenant_idp_update ON core.tenant_identity_providers FOR UPDATE
      USING (tenant_id = ${tenantIdExpr}) WITH CHECK (tenant_id = ${tenantIdExpr});
    `);
    await queryRunner.query(`
      CREATE POLICY tenant_idp_delete ON core.tenant_identity_providers FOR DELETE USING (tenant_id = ${tenantIdExpr});
    `);

    // -------------------------------------------------------------------
    // Grants
    // -------------------------------------------------------------------
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.tenant_identity_providers TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.webauthn_credentials TO agno_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.policies DROP CONSTRAINT policies_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.policies ADD CONSTRAINT policies_type_check CHECK (
        policy_type IN ('overtime_rule','break_rule','approval_chain','data_retention','rate_limit')
      );
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS core.webauthn_credentials;`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.tenant_identity_providers;`);
  }
}
