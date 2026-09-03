import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 07 Phase 7 (§2.2 rule 3, ADR-0091): the ledger `marketplace_
 * engagement_score`'s own doc comment already promised - "every individual
 * point/badge/streak change must be traceable to which action earned it and
 * when." A separate migration, not an amendment to `InitialMarketplaceSchema`
 * (unlike every schema change in Phases 2-6, that migration has already run
 * against every environment this module has touched by this point - editing
 * an applied migration's `up()` would never re-execute).
 *
 * `marketplace_engagement_event` mirrors attendance-leave-service's own
 * `attendance_ingestion_event` shape most closely among this platform's
 * existing ledgers (plain single-table insert-only, not partitioned like
 * `core.audit_log`/`intraday.adherence_event` - this table's volume is
 * bounded by real marketplace completions, nowhere near either of those
 * tables' scale): `GRANT SELECT, INSERT` only, no UPDATE/DELETE - the same
 * "append-only enforced by grant, not by RLS" convention (RLS's own
 * `tenant_isolation` policy shape is identical whether or not a table is
 * append-only).
 *
 * `reference_id` (the triggering `MarketplaceClaim`/`SwapRequest` row) stays
 * a plain `uuid`, no `REFERENCES` - unlike `attendance_ingestion_event`'s
 * own real FK to a single table it owns, this column is polymorphic across
 * two different marketplace tables depending on `event_type`, so a single
 * FK constraint doesn't fit even though both are same-schema.
 *
 * `last_engagement_date` is a new column on the existing
 * `marketplace_engagement_score` (not the ledger) - streak continuity needs
 * to know the calendar date of the *previous* qualifying event to decide
 * "consecutive day" vs. "gap, reset to 1" without re-deriving it from a full
 * ledger scan on every write.
 */
export class MarketplaceEngagementLedgerSchema1700002000000 implements MigrationInterface {
  name = 'MarketplaceEngagementLedgerSchema1700002000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      ALTER TABLE marketplace.marketplace_engagement_score
      ADD COLUMN last_engagement_date date;
    `);

    await queryRunner.query(`
      CREATE TABLE marketplace.marketplace_engagement_event (
        id                uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        employee_id       uuid NOT NULL,
        event_type        varchar(20) NOT NULL,
        reference_id      uuid NOT NULL,
        points_delta      integer NOT NULL,
        streak_days_after integer NOT NULL,
        badges_awarded    jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT marketplace_engagement_event_event_type_check
          CHECK (event_type IN ('claim_approved', 'swap_executed'))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_marketplace_engagement_event_tenant_employee
      ON marketplace.marketplace_engagement_event (tenant_id, employee_id, created_at DESC);
    `);

    await queryRunner.query(`ALTER TABLE marketplace.marketplace_engagement_event ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON marketplace.marketplace_engagement_event FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT ON marketplace.marketplace_engagement_event TO agno_marketplace_app;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS marketplace.marketplace_engagement_event;`);
    await queryRunner.query(`
      ALTER TABLE marketplace.marketplace_engagement_score
      DROP COLUMN IF EXISTS last_engagement_date;
    `);
  }
}
