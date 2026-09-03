import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 02 Phase 6 — transactional outbox (§4's `EmployeeChanged`/
 * `SkillExpiring` NATS events), bulk HRIS import job tracking (§3.2,
 * §0.5), and per-tenant feature flags (§0.5's progressive-delivery
 * requirement for bulk import's destructive mode). See
 * docs/adr/0019-outbox-and-bulk-import.md.
 */
export class Module02EventingAndBulkImport1700000003000 implements MigrationInterface {
  name = 'Module02EventingAndBulkImport1700000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------------
    // outbox_events (ADR-0019: transactional outbox)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.outbox_events (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL REFERENCES core.tenants(id),
        subject       varchar(255) NOT NULL,
        payload       jsonb NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        published_at  timestamptz,
        attempts      integer NOT NULL DEFAULT 0,
        last_error    text
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_outbox_events_tenant_id_published_at ON org.outbox_events (tenant_id, published_at);
    `);
    // The publisher's actual poll query is cross-tenant (it has no single
    // tenant to scope to - see OutboxPublisherService) and filters
    // unpublished rows regardless of tenant, so it also needs an index
    // that doesn't lead with tenant_id.
    await queryRunner.query(`
      CREATE INDEX idx_outbox_events_published_at_null ON org.outbox_events (created_at) WHERE published_at IS NULL;
    `);

    // ---------------------------------------------------------------------
    // bulk_import_jobs (§3.2 async job pattern)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.bulk_import_jobs (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL REFERENCES core.tenants(id),
        idempotency_key   varchar(255),
        status            varchar(20) NOT NULL DEFAULT 'pending',
        dry_run           boolean NOT NULL DEFAULT false,
        total_records     integer NOT NULL DEFAULT 0,
        result            jsonb,
        error             text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        started_at        timestamptz,
        completed_at      timestamptz,
        CONSTRAINT bulk_import_jobs_status_check CHECK (status IN ('pending','running','completed','failed'))
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_bulk_import_jobs_tenant_idempotency_key ON org.bulk_import_jobs (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);
    await queryRunner.query(
      `CREATE INDEX idx_bulk_import_jobs_tenant_id_status ON org.bulk_import_jobs (tenant_id, status);`,
    );

    // ---------------------------------------------------------------------
    // feature_flags (§0.5 progressive delivery)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.feature_flags (
        tenant_id   uuid NOT NULL REFERENCES core.tenants(id),
        flag_key    varchar(100) NOT NULL,
        enabled     boolean NOT NULL DEFAULT false,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, flag_key)
      );
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_feature_flags_updated_at BEFORE UPDATE ON org.feature_flags
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    // ---------------------------------------------------------------------
    // RLS + grants
    // ---------------------------------------------------------------------
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const platformAdminExpr = `current_setting('app.is_platform_admin', true) = 'true'`;

    // outbox_events: the publisher runs as a platform-admin session (ADR-0019)
    // since it polls across every tenant, not one - same escape-hatch shape
    // as core.tenants (ADR-0007), reused here rather than inventing a second
    // cross-tenant mechanism.
    await queryRunner.query(`ALTER TABLE org.outbox_events ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON org.outbox_events FOR ALL
      USING (${platformAdminExpr} OR tenant_id = ${tenantIdExpr})
      WITH CHECK (${platformAdminExpr} OR tenant_id = ${tenantIdExpr});
    `);
    // No DELETE - published events are a durable record of what was sent,
    // same append-only posture as audit_log/decay_job_runs.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON org.outbox_events TO agno_app;`);

    for (const table of ['bulk_import_jobs', 'feature_flags']) {
      await queryRunner.query(`ALTER TABLE org.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON org.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON org.${table} TO agno_app;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS org.feature_flags;`);
    await queryRunner.query(`DROP TABLE IF EXISTS org.bulk_import_jobs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS org.outbox_events;`);
  }
}
