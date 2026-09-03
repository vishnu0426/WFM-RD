import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 12 Phase 1 (§2, ADR-0134, ADR-0135, ADR-0136): the full §2.1 entity
 * set in one migration, per this phase's own scope ("Schema & migrations.
 * All entities in §2, including sync_type: streaming on SyncJob from day
 * one"). Reuses the platform's `app.current_tenant_id` RLS convention
 * (ADR-0002) and the shared-database/new-schema/new-role pattern
 * (ADR-0017/0052/0066/0073/0083/0093/0108/0113, restated for this schema in
 * ADR-0136) unchanged. Enum-typed columns are `varchar` + `CHECK`, not
 * native Postgres `ENUM` (ADR-0003). `provider` is deliberately left as an
 * unconstrained `varchar` (§2.1 does not annotate it as an enum the way
 * `connector_type`/`status` are) so a new provider adapter never needs a
 * `CHECK`-constraint migration just to exist.
 *
 * `FieldMapping`, `SyncJob`, and `WebhookDelivery` are not given a
 * `tenant_id` column directly by §2.1 - only a `connector_id`/
 * `webhook_subscription_id` foreign key. ADR-0002 rule 1 requires RLS and a
 * tenant-id-first index "on every tenant-scoped table, no exceptions," so
 * `tenant_id` is denormalized onto all three following ADR-0004's precedent
 * (`user_roles`/`notification_preferences`): a genuine composite foreign key
 * `(tenant_id, <parent>_id) REFERENCES <parent>(tenant_id, id)`, safe here
 * because `integration_connector.tenant_id`/`webhook_subscription.tenant_id`
 * are both `NOT NULL` (no global/system-level connector or subscription
 * concept exists in this module, unlike ADR-0004's nullable-parent case for
 * `roles`).
 *
 * `WebhookDelivery.created_at` is one deliberate addition beyond §2.1's
 * literal column list: the spec gives this table `delivered_at` (nullable,
 * set only on eventual success) but nothing to order "most recent delivery
 * attempts" by before a delivery succeeds - every other history/append-log
 * table in this platform (`audit_log`, `sync_job` via `started_at`) carries
 * exactly this kind of ordering timestamp. See the Phase 1 design doc's
 * explicit-assumptions section.
 *
 * `ProviderRateLimitConfig` is the one table in this schema with no
 * `tenant_id` and no RLS - it is platform-operator-maintained reference
 * data (`docs/module-12-provider-research.md`), not tenant-configured data,
 * the same carve-out ADR-0002 already makes for global `Permission`/system
 * `Role` rows.
 */
export class InitialIntegrationHubSchema1700010000000 implements MigrationInterface {
  name = 'InitialIntegrationHubSchema1700010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS integration_hub;`);

    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -----------------------------------------------------------------------
    // integration_connector (§2.1)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE integration_hub.integration_connector (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        connector_type      varchar(20) NOT NULL,
        provider            varchar(100) NOT NULL,
        status              varchar(20) NOT NULL DEFAULT 'pending_setup',
        config              jsonb NOT NULL DEFAULT '{}'::jsonb,
        last_sync_at        timestamptz,
        last_sync_status    varchar(20),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CONSTRAINT integration_connector_connector_type_check
          CHECK (connector_type IN ('hris', 'payroll', 'acd', 'crm', 'custom_webhook')),
        CONSTRAINT integration_connector_status_check
          CHECK (status IN ('active', 'paused', 'error', 'pending_setup')),
        CONSTRAINT integration_connector_last_sync_status_check
          CHECK (last_sync_status IS NULL OR last_sync_status IN ('queued', 'running', 'completed', 'failed', 'partial_failure'))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_integration_connector_tenant_connector_type
      ON integration_hub.integration_connector (tenant_id, connector_type);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_integration_connector_tenant_status
      ON integration_hub.integration_connector (tenant_id, status);
    `);

    // -----------------------------------------------------------------------
    // field_mapping (§2.1, §2.2 rule 5, §5b)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE integration_hub.field_mapping (
        id                    uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id             uuid NOT NULL,
        connector_id          uuid NOT NULL,
        source_field          varchar(200) NOT NULL,
        target_field          varchar(200) NOT NULL,
        transformation_rule   jsonb,
        authority             varchar(30),
        PRIMARY KEY (id),
        UNIQUE (connector_id, source_field),
        CONSTRAINT field_mapping_connector_fk
          FOREIGN KEY (tenant_id, connector_id)
          REFERENCES integration_hub.integration_connector (tenant_id, id),
        -- §2.2 rule 5: meaningful for connector_type hris|payroll|crm only;
        -- deliberately nullable rather than defaulted to manual_review so an
        -- acd connector's mappings carry no authority value at all, not a
        -- default this module would then have to special-case away.
        CONSTRAINT field_mapping_authority_check
          CHECK (authority IS NULL OR authority IN ('source_authoritative', 'agno_authoritative', 'manual_review'))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_field_mapping_tenant_connector
      ON integration_hub.field_mapping (tenant_id, connector_id);
    `);

    // -----------------------------------------------------------------------
    // sync_job (§2.1, §2.2 rule 5, §5c)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE integration_hub.sync_job (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        connector_id        uuid NOT NULL,
        sync_type           varchar(20) NOT NULL,
        status              varchar(20) NOT NULL DEFAULT 'queued',
        records_processed   integer NOT NULL DEFAULT 0,
        records_failed      integer NOT NULL DEFAULT 0,
        records_conflicted  integer,
        error_details       jsonb,
        started_at          timestamptz NOT NULL DEFAULT now(),
        completed_at        timestamptz,
        PRIMARY KEY (id),
        CONSTRAINT sync_job_connector_fk
          FOREIGN KEY (tenant_id, connector_id)
          REFERENCES integration_hub.integration_connector (tenant_id, id),
        CONSTRAINT sync_job_sync_type_check
          CHECK (sync_type IN ('full', 'incremental', 'streaming')),
        CONSTRAINT sync_job_status_check
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'partial_failure')),
        CONSTRAINT sync_job_records_processed_non_negative_check CHECK (records_processed >= 0),
        CONSTRAINT sync_job_records_failed_non_negative_check CHECK (records_failed >= 0),
        CONSTRAINT sync_job_records_conflicted_non_negative_check
          CHECK (records_conflicted IS NULL OR records_conflicted >= 0),
        CONSTRAINT sync_job_completed_after_started_check
          CHECK (completed_at IS NULL OR completed_at >= started_at),
        -- §2.1/§2.2 rule 5: records_conflicted is structurally impossible on a
        -- streaming (ACD) row, the same "make the invariant impossible to
        -- violate at the schema layer" posture ADR-0054/leave_request's
        -- backdated-reason check both established - a future write path can
        -- never silently populate a conflict count for a connector type that
        -- has nothing to conflict against.
        CONSTRAINT sync_job_streaming_has_no_conflicts_check
          CHECK (sync_type <> 'streaming' OR records_conflicted IS NULL)
      );
    `);
    // Backs `syncJobHistory(connectorId, limit)` (§3.1).
    await queryRunner.query(`
      CREATE INDEX idx_sync_job_tenant_connector_started_at
      ON integration_hub.sync_job (tenant_id, connector_id, started_at DESC);
    `);

    // -----------------------------------------------------------------------
    // webhook_subscription (§2.1)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE integration_hub.webhook_subscription (
        id                            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                     uuid NOT NULL,
        event_types                   text[] NOT NULL DEFAULT '{}',
        target_url                    varchar(2048) NOT NULL,
        secret_reference               varchar(500) NOT NULL,
        status                        varchar(20) NOT NULL DEFAULT 'active',
        consecutive_failure_count      integer NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CONSTRAINT webhook_subscription_status_check
          CHECK (status IN ('active', 'failing', 'disabled')),
        CONSTRAINT webhook_subscription_consecutive_failure_count_non_negative_check
          CHECK (consecutive_failure_count >= 0)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_webhook_subscription_tenant_status
      ON integration_hub.webhook_subscription (tenant_id, status);
    `);

    // -----------------------------------------------------------------------
    // webhook_delivery (§2.1, §4.2)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE integration_hub.webhook_delivery (
        id                          uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                   uuid NOT NULL,
        webhook_subscription_id     uuid NOT NULL,
        event_type                  varchar(100) NOT NULL,
        payload                     jsonb NOT NULL,
        response_status_code        integer,
        delivered_at                timestamptz,
        retry_count                 integer NOT NULL DEFAULT 0,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT webhook_delivery_subscription_fk
          FOREIGN KEY (tenant_id, webhook_subscription_id)
          REFERENCES integration_hub.webhook_subscription (tenant_id, id),
        CONSTRAINT webhook_delivery_retry_count_non_negative_check CHECK (retry_count >= 0)
      );
    `);
    // Backs `webhookDeliveries(subscriptionId, limit)` (§3.1).
    await queryRunner.query(`
      CREATE INDEX idx_webhook_delivery_tenant_subscription_created_at
      ON integration_hub.webhook_delivery (tenant_id, webhook_subscription_id, created_at DESC);
    `);

    // -----------------------------------------------------------------------
    // provider_rate_limit_config (§2.1, §5a, §5c, ADR-0136) - global
    // reference data, no tenant_id, no RLS (same carve-out ADR-0002 makes
    // for core.permission/system-global roles).
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE integration_hub.provider_rate_limit_config (
        id                          uuid NOT NULL DEFAULT gen_random_uuid(),
        provider                    varchar(100) NOT NULL,
        requests_per_window         integer,
        window_seconds              integer,
        concurrent_request_limit    integer,
        backoff_strategy            jsonb NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (id),
        UNIQUE (provider),
        CONSTRAINT provider_rate_limit_config_requests_per_window_non_negative_check
          CHECK (requests_per_window IS NULL OR requests_per_window >= 0),
        CONSTRAINT provider_rate_limit_config_window_seconds_positive_check
          CHECK (window_seconds IS NULL OR window_seconds > 0),
        -- §5a/§5c: repurposed for streaming providers as "max concurrent
        -- monitored links/sessions" rather than a request-count ceiling
        -- (ADR-0135) - the column stays a plain non-negative integer either
        -- way, only its meaning differs per-provider.
        CONSTRAINT provider_rate_limit_config_concurrent_request_limit_non_negative_check
          CHECK (concurrent_request_limit IS NULL OR concurrent_request_limit >= 0)
      );
    `);

    // -----------------------------------------------------------------------
    // field_authority_policy (§2.1, §2.2 rule 5, §5b)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE integration_hub.field_authority_policy (
        id                      uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id               uuid NOT NULL,
        connector_id            uuid NOT NULL,
        field_name              varchar(200) NOT NULL,
        authoritative_source    varchar(20) NOT NULL,
        conflict_action         varchar(20) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (connector_id, field_name),
        CONSTRAINT field_authority_policy_connector_fk
          FOREIGN KEY (tenant_id, connector_id)
          REFERENCES integration_hub.integration_connector (tenant_id, id),
        CONSTRAINT field_authority_policy_authoritative_source_check
          CHECK (authoritative_source IN ('external_system', 'agno_wfm')),
        CONSTRAINT field_authority_policy_conflict_action_check
          CHECK (conflict_action IN ('overwrite', 'flag_for_review', 'reject_sync'))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_field_authority_policy_tenant_connector
      ON integration_hub.field_authority_policy (tenant_id, connector_id);
    `);

    // -----------------------------------------------------------------------
    // Row Level Security (ADR-0002, unchanged convention). Every table
    // except provider_rate_limit_config - see that table's own comment.
    // -----------------------------------------------------------------------
    const tenantScopedTables = [
      'integration_connector',
      'field_mapping',
      'sync_job',
      'webhook_subscription',
      'webhook_delivery',
      'field_authority_policy',
    ];
    for (const table of tenantScopedTables) {
      await queryRunner.query(`ALTER TABLE integration_hub.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON integration_hub.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // -----------------------------------------------------------------------
    // Grants - agno_integration_hub_app is the runtime role (ADR-0136). No
    // table here has a real delete mutation in §3, so no DELETE grant
    // anywhere. provider_rate_limit_config is SELECT-only for the app role -
    // it is seeded/maintained by agno_migrator, never written by the running
    // application (ADR-0136).
    // -----------------------------------------------------------------------
    await queryRunner.query(`GRANT USAGE ON SCHEMA integration_hub TO agno_integration_hub_app;`);
    const appWritableTables = [
      'integration_connector',
      'field_mapping',
      'sync_job',
      'webhook_subscription',
      'webhook_delivery',
      'field_authority_policy',
    ];
    for (const table of appWritableTables) {
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON integration_hub.${table} TO agno_integration_hub_app;`);
    }
    await queryRunner.query(`GRANT SELECT ON integration_hub.provider_rate_limit_config TO agno_integration_hub_app;`);
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA integration_hub FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS integration_hub CASCADE;`);
  }
}
