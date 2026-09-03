import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 — full initial schema for Module 01 (Tenant, Identity, Policy, Audit,
 * Notification). See docs/phase-1-design-doc.md and docs/adr/0001-0006 for the
 * reasoning behind every non-obvious choice below (denormalized tenant_id,
 * varchar+CHECK enums, audit_log partitioning, policy_group_id lineage).
 *
 * `core.tenants` IS RLS-protected (see the tenants_* policies below) - an
 * earlier version of this migration left it unprotected on the theory that
 * resolving "which tenant is this" would be circular. That was wrong:
 * `app.current_tenant_id` is sourced from the validated JWT's `tenant_id`
 * claim (§3.4), never from a `tenants` row lookup, so there is no ordering
 * problem. A second session GUC, `app.is_platform_admin`, is the escape
 * hatch for cross-tenant platform-admin operations (§3.2's admin-only
 * `POST /v1/tenants`) - set the same way as `app.current_tenant_id` (from
 * validated identity, never client input), never trusted from anywhere else.
 */
export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------------
    // Schema + shared trigger functions
    // ---------------------------------------------------------------------
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS core;`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.fn_set_updated_at()
      RETURNS trigger AS $$
      BEGIN
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ADR-0004: role_permissions.tenant_id must always mirror its parent
    // role's tenant_id (including NULL for system-global roles). A composite
    // FK cannot express this safely (MATCH SIMPLE/FULL both have a hole for
    // the nullable-tenant case), so a trigger is the enforcement mechanism.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.fn_sync_tenant_id_from_role()
      RETURNS trigger AS $$
      BEGIN
        SELECT tenant_id INTO NEW.tenant_id FROM core.roles WHERE id = NEW.role_id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ---------------------------------------------------------------------
    // tenants
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.tenants (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name                   varchar(255) NOT NULL,
        parent_tenant_id       uuid REFERENCES core.tenants(id),
        tier                   varchar(20) NOT NULL,
        data_residency_region  varchar(50) NOT NULL,
        status                 varchar(20) NOT NULL DEFAULT 'provisioning',
        created_at             timestamptz NOT NULL DEFAULT now(),
        updated_at             timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT tenants_tier_check CHECK (tier IN ('smb','enterprise','bpo')),
        CONSTRAINT tenants_status_check CHECK (status IN ('active','suspended','provisioning','deprovisioned')),
        CONSTRAINT tenants_not_self_parent CHECK (parent_tenant_id IS NULL OR parent_tenant_id <> id)
      );
    `);
    await queryRunner.query(`CREATE INDEX idx_tenants_parent_tenant_id ON core.tenants (parent_tenant_id);`);
    await queryRunner.query(`
      CREATE TRIGGER trg_tenants_updated_at BEFORE UPDATE ON core.tenants
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    // ---------------------------------------------------------------------
    // users
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.users (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL REFERENCES core.tenants(id),
        external_idp_id   varchar(255),
        email             varchar(320) NOT NULL,
        status            varchar(20) NOT NULL DEFAULT 'invited',
        mfa_enabled       boolean NOT NULL DEFAULT false,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_status_check CHECK (status IN ('active','invited','disabled')),
        CONSTRAINT uq_users_tenant_id_id UNIQUE (tenant_id, id)
      );
    `);
    // Email is unique PER TENANT (§2.1), case-insensitively.
    await queryRunner.query(`CREATE UNIQUE INDEX uq_users_tenant_id_email ON core.users (tenant_id, lower(email));`);
    await queryRunner.query(`CREATE INDEX idx_users_tenant_id_status ON core.users (tenant_id, status);`);
    await queryRunner.query(`
      CREATE INDEX idx_users_tenant_id_external_idp_id ON core.users (tenant_id, external_idp_id)
      WHERE external_idp_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON core.users
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    // ---------------------------------------------------------------------
    // roles
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.roles (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid REFERENCES core.tenants(id),
        name            varchar(100) NOT NULL,
        is_system_role  boolean NOT NULL DEFAULT false,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT roles_system_role_tenant_consistency CHECK (
          (is_system_role AND tenant_id IS NULL) OR (NOT is_system_role AND tenant_id IS NOT NULL)
        )
      );
    `);
    // Role name unique per tenant, and separately unique among system-global
    // roles - a plain UNIQUE(tenant_id, name) would let two tenant_id=NULL
    // rows share a name because Postgres treats NULLs as distinct in unique
    // indexes, so this needs two partial indexes.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_roles_tenant_id_name ON core.roles (tenant_id, name) WHERE tenant_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_roles_system_role_name ON core.roles (name) WHERE tenant_id IS NULL;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON core.roles
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    // ---------------------------------------------------------------------
    // permissions (global reference data, not tenant-scoped)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.permissions (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        resource    varchar(100) NOT NULL,
        action      varchar(20) NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT permissions_action_check CHECK (action IN ('read','write','approve','delete')),
        CONSTRAINT uq_permissions_resource_action UNIQUE (resource, action)
      );
    `);

    // ---------------------------------------------------------------------
    // role_permissions (join; ADR-0004 trigger-synced tenant_id)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.role_permissions (
        role_id        uuid NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
        permission_id  uuid NOT NULL REFERENCES core.permissions(id) ON DELETE CASCADE,
        tenant_id      uuid,
        created_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (role_id, permission_id)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_role_permissions_tenant_id_role_id ON core.role_permissions (tenant_id, role_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_role_permissions_permission_id ON core.role_permissions (permission_id);`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_role_permissions_sync_tenant BEFORE INSERT OR UPDATE OF role_id ON core.role_permissions
      FOR EACH ROW EXECUTE FUNCTION core.fn_sync_tenant_id_from_role();
    `);

    // ---------------------------------------------------------------------
    // user_roles (join, enables ABAC via scope_org_unit_id; ADR-0004 composite FK)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.user_roles (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        user_id            uuid NOT NULL,
        role_id            uuid NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
        -- Opaque reference to Module 02's OrgUnit.id. No cross-module FK by
        -- design (bounded-context boundary) - NULL means tenant-wide scope.
        scope_org_unit_id  uuid,
        created_at         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_user_roles_tenant_user FOREIGN KEY (tenant_id, user_id)
          REFERENCES core.users(tenant_id, id) ON DELETE CASCADE
      );
    `);
    // tenant_id leads both indexes per §2.2 rule 1 ("no exceptions" for
    // composite indexes on tenant-scoped tables), even though user_id alone
    // already disambiguates within a tenant.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_user_roles_tenant_wide ON core.user_roles (tenant_id, user_id, role_id) WHERE scope_org_unit_id IS NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_user_roles_scoped ON core.user_roles (tenant_id, user_id, role_id, scope_org_unit_id) WHERE scope_org_unit_id IS NOT NULL;
    `);
    await queryRunner.query(`CREATE INDEX idx_user_roles_tenant_id_user_id ON core.user_roles (tenant_id, user_id);`);
    await queryRunner.query(`CREATE INDEX idx_user_roles_tenant_id_role_id ON core.user_roles (tenant_id, role_id);`);

    // ---------------------------------------------------------------------
    // policies (ADR-0006 policy_group_id lineage)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.policies (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL REFERENCES core.tenants(id),
        -- Self-referencing lineage key: the first version sets
        -- policy_group_id = id; later versions reuse it. Maps to
        -- {policyId} in GET /v1/policies/{policyId}/history (Phase 6).
        policy_group_id   uuid NOT NULL,
        policy_type       varchar(30) NOT NULL,
        definition        jsonb NOT NULL,
        effective_from    timestamptz NOT NULL,
        effective_to      timestamptz,
        version           integer NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT policies_type_check CHECK (
          policy_type IN ('overtime_rule','break_rule','approval_chain','data_retention','rate_limit')
        ),
        CONSTRAINT policies_version_positive CHECK (version > 0),
        CONSTRAINT policies_effective_range CHECK (effective_to IS NULL OR effective_to > effective_from),
        CONSTRAINT uq_policies_tenant_group_version UNIQUE (tenant_id, policy_group_id, version)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_policies_tenant_id_group_id ON core.policies (tenant_id, policy_group_id);`,
    );
    await queryRunner.query(`CREATE INDEX idx_policies_tenant_id_type ON core.policies (tenant_id, policy_type);`);
    await queryRunner.query(
      `CREATE INDEX idx_policies_definition_gin ON core.policies USING gin (definition jsonb_path_ops);`,
    );
    // At most one "currently open" version per policy lineage.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_policies_one_open_version ON core.policies (tenant_id, policy_group_id) WHERE effective_to IS NULL;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_policies_updated_at BEFORE UPDATE ON core.policies
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    // ---------------------------------------------------------------------
    // audit_log (ADR-0005: partitioned, append-only)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.audit_log (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL REFERENCES core.tenants(id),
        actor_id       uuid,
        actor_type     varchar(20) NOT NULL,
        action         varchar(100) NOT NULL,
        resource_type  varchar(100) NOT NULL,
        resource_id    uuid,
        before_state   jsonb,
        after_state    jsonb,
        ai_rationale   jsonb,
        created_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('user','system','ai_agent')),
        -- §2.2 rule 3, enforced at the DB level as defense-in-depth
        -- alongside the application-layer guard built in Phase 5.
        CONSTRAINT audit_log_ai_rationale_required CHECK (actor_type <> 'ai_agent' OR ai_rationale IS NOT NULL),
        PRIMARY KEY (id, created_at)
      ) PARTITION BY RANGE (created_at);
    `);
    await queryRunner.query(
      `CREATE INDEX idx_audit_log_tenant_id_created_at ON core.audit_log (tenant_id, created_at DESC);`,
    );
    await queryRunner.query(`CREATE INDEX idx_audit_log_tenant_id_actor_id ON core.audit_log (tenant_id, actor_id);`);
    await queryRunner.query(
      `CREATE INDEX idx_audit_log_tenant_id_resource ON core.audit_log (tenant_id, resource_type, resource_id);`,
    );

    // Local-dev partition bootstrap: current month, one month back, two
    // months forward. Production partition rotation is pg_partman
    // (infra work - see docs/production-readiness-checklist.md), not this
    // migration.
    await queryRunner.query(`
      DO $do$
      DECLARE
        start_month date := date_trunc('month', now())::date;
        i integer;
        part_name text;
        part_start date;
        part_end date;
      BEGIN
        FOR i IN -1..2 LOOP
          part_start := (start_month + (i || ' month')::interval)::date;
          part_end := (start_month + ((i + 1) || ' month')::interval)::date;
          part_name := 'audit_log_' || to_char(part_start, 'YYYY_MM');
          EXECUTE format(
            'CREATE TABLE core.%I PARTITION OF core.audit_log FOR VALUES FROM (%L) TO (%L)',
            part_name, part_start, part_end
          );
        END LOOP;
      END
      $do$;
    `);

    // ---------------------------------------------------------------------
    // notification_preferences (ADR-0004 composite FK)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE core.notification_preferences (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        user_id             uuid NOT NULL,
        channel             varchar(20) NOT NULL,
        event_type          varchar(100) NOT NULL,
        enabled             boolean NOT NULL DEFAULT true,
        quiet_hours_start   time,
        quiet_hours_end     time,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT notification_preferences_channel_check CHECK (channel IN ('email','sms','push','in_app')),
        CONSTRAINT fk_notification_preferences_tenant_user FOREIGN KEY (tenant_id, user_id)
          REFERENCES core.users(tenant_id, id) ON DELETE CASCADE,
        -- tenant_id leads per §2.2 rule 1, though user_id alone would
        -- already disambiguate within a tenant.
        CONSTRAINT uq_notification_preferences_user_channel_event UNIQUE (tenant_id, user_id, channel, event_type)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_notification_preferences_tenant_id_user_id ON core.notification_preferences (tenant_id, user_id);
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_notification_preferences_updated_at BEFORE UPDATE ON core.notification_preferences
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    // ---------------------------------------------------------------------
    // Row Level Security - defense-in-depth under the application guard
    // (ADR-0002). app.current_tenant_id is set via SET LOCAL by
    // TenantScopedRepository, sourced only from the validated request
    // context, never from client input.
    // ---------------------------------------------------------------------
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    for (const table of ['users', 'policies', 'user_roles', 'notification_preferences']) {
      await queryRunner.query(`ALTER TABLE core.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON core.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // roles / role_permissions: global rows (tenant_id IS NULL) are readable
    // by every tenant but only writable by the migrator/platform-admin path.
    for (const table of ['roles', 'role_permissions']) {
      await queryRunner.query(`ALTER TABLE core.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY ${table}_read ON core.${table} FOR SELECT
        USING (tenant_id = ${tenantIdExpr} OR tenant_id IS NULL);
      `);
      await queryRunner.query(`
        CREATE POLICY ${table}_insert ON core.${table} FOR INSERT
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
      await queryRunner.query(`
        CREATE POLICY ${table}_update ON core.${table} FOR UPDATE
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
      await queryRunner.query(`
        CREATE POLICY ${table}_delete ON core.${table} FOR DELETE
        USING (tenant_id = ${tenantIdExpr});
      `);
    }

    // audit_log: same tenant_isolation shape as the first group. GRANT-level
    // revoke of UPDATE/DELETE below is the real append-only enforcement;
    // RLS here only prevents cross-tenant reads/inserts.
    await queryRunner.query(`ALTER TABLE core.audit_log ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON core.audit_log FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    // tenants: self + BPO children + platform-admin escape hatch. Not the
    // same shape as the other tables (there's no tenant_id column - id IS
    // the tenant identity), so it gets its own predicate rather than
    // reusing the generic loops above.
    const platformAdminExpr = `current_setting('app.is_platform_admin', true) = 'true'`;
    await queryRunner.query(`ALTER TABLE core.tenants ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenants_select ON core.tenants FOR SELECT
      USING (${platformAdminExpr} OR id = ${tenantIdExpr} OR parent_tenant_id = ${tenantIdExpr});
    `);
    // A tenant may onboard a child tenant under itself (BPO multi-client
    // onboarding); platform admins may create any tenant, including new
    // top-level ones (parent_tenant_id IS NULL).
    await queryRunner.query(`
      CREATE POLICY tenants_insert ON core.tenants FOR INSERT
      WITH CHECK (${platformAdminExpr} OR parent_tenant_id = ${tenantIdExpr});
    `);
    // A tenant may update itself or a direct BPO child it owns; platform
    // admins may update any tenant.
    await queryRunner.query(`
      CREATE POLICY tenants_update ON core.tenants FOR UPDATE
      USING (${platformAdminExpr} OR id = ${tenantIdExpr} OR parent_tenant_id = ${tenantIdExpr})
      WITH CHECK (${platformAdminExpr} OR id = ${tenantIdExpr} OR parent_tenant_id = ${tenantIdExpr});
    `);
    // No tenants_delete policy: agno_app has no DELETE grant on tenants at
    // all (see the GRANT statements below) - deprovisioning is modeled via
    // status = 'deprovisioned', not row deletion.

    // permissions: intentionally no RLS (global reference data, not tenant
    // data - see the entity's own doc comment).

    // ---------------------------------------------------------------------
    // Grants - agno_app is the runtime role. §2.2 rule 2: it must not have
    // UPDATE/DELETE on audit_log at the grant level, not just by convention.
    // ---------------------------------------------------------------------
    await queryRunner.query(`GRANT USAGE ON SCHEMA core TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.tenants TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.users TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.roles TO agno_app;`);
    await queryRunner.query(`GRANT SELECT ON core.permissions TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.role_permissions TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.user_roles TO agno_app;`);
    // No DELETE on policies - versions are immutable history (ADR-0006);
    // expiry is modeled via effective_to, not row deletion.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.policies TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT ON core.audit_log TO agno_app;`);
    await queryRunner.query(`REVOKE UPDATE, DELETE ON core.audit_log FROM agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.notification_preferences TO agno_app;`);
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA core FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS core CASCADE;`);
  }
}
