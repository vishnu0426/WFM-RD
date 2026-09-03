import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 07 Phase 1 (§2, §5.1, §5.2, ADR-0083): the full §2.1 entity set in
 * one migration, per this phase's own scope ("All entities in §2 including
 * rank_position/rank_explanation and abuse-tracking fields from day one -
 * not retrofitted"). Reuses Module 01's `app.current_tenant_id` RLS
 * convention (ADR-0002) and the shared-database/new-schema/new-role pattern
 * (ADR-0017/0052/0066/0073, restated for this schema in ADR-0083) unchanged.
 * Enum-typed columns are `varchar` + `CHECK`, not native Postgres `ENUM`
 * (ADR-0003).
 *
 * `tenant_id` is added to `marketplace_claim`/`bid_opportunity`/`bid` even
 * though the module prompt's own abbreviated §2.1 DDL block didn't spell it
 * out for those three - every table in this schema needs it for the RLS
 * `tenant_isolation` policy below, the same non-negotiable every other
 * schema in this platform already enforces.
 *
 * `marketplace_claim.marketplace_post_id` and `bid.bid_opportunity_id` are
 * real `REFERENCES` (intra-schema, both tables live in `marketplace`) -
 * unlike the cross-module uuid-only columns (`shift_assignment_id`,
 * `claimant_employee_id`, etc.), which stay plain `uuid` per
 * ADR-0052/0073's "cross-module referential correctness is a contract
 * concern, not Postgres's" convention.
 *
 * No table here is append-only in the `audit_log`/`adherence_event` sense -
 * every state change (a post expiring, a claim being rejected, a bid
 * opportunity closing) is a status-column UPDATE, so `agno_marketplace_app`
 * is granted SELECT/INSERT/UPDATE on all six, never DELETE.
 */
export class InitialMarketplaceSchema1700001000000 implements MigrationInterface {
  name = 'InitialMarketplaceSchema1700001000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS marketplace;`);

    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -----------------------------------------------------------------------
    // marketplace_post (§2.1)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE marketplace.marketplace_post (
        id                    uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id             uuid NOT NULL,
        post_type             varchar(20) NOT NULL,
        shift_assignment_id   uuid NOT NULL,
        org_unit_id           uuid NOT NULL,
        posted_by             uuid,
        status                varchar(20) NOT NULL DEFAULT 'open',
        eligibility_rules     jsonb NOT NULL DEFAULT '{}'::jsonb,
        expires_at            timestamptz NOT NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT marketplace_post_type_check
          CHECK (post_type IN ('open_shift', 'swap', 'bid')),
        CONSTRAINT marketplace_post_status_check
          CHECK (status IN ('open', 'claimed', 'expired', 'cancelled'))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_marketplace_post_tenant_status
      ON marketplace.marketplace_post (tenant_id, status);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_marketplace_post_shift_assignment_id
      ON marketplace.marketplace_post (shift_assignment_id);
    `);
    // §3.1: the marketplacePostUpdated(orgUnitId) subscription's own filter
    // grain.
    await queryRunner.query(`
      CREATE INDEX idx_marketplace_post_tenant_org_unit_status
      ON marketplace.marketplace_post (tenant_id, org_unit_id, status);
    `);
    // §4 step 5: an expired-but-still-open post is this module's own
    // sweep target - filtered by tenant + status + expiry, not a full scan.
    await queryRunner.query(`
      CREATE INDEX idx_marketplace_post_tenant_status_expires_at
      ON marketplace.marketplace_post (tenant_id, status, expires_at)
      WHERE status = 'open';
    `);

    // -----------------------------------------------------------------------
    // marketplace_claim (§2.1, §2.2 rule 2)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE marketplace.marketplace_claim (
        id                       uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                uuid NOT NULL,
        marketplace_post_id      uuid NOT NULL,
        claimant_employee_id     uuid NOT NULL,
        status                   varchar(20) NOT NULL DEFAULT 'pending_validation',
        validation_result        jsonb,
        claimed_at               timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT marketplace_claim_post_fk
          FOREIGN KEY (marketplace_post_id) REFERENCES marketplace.marketplace_post (id),
        CONSTRAINT marketplace_claim_status_check
          CHECK (status IN ('pending_validation', 'pending_approval', 'approved', 'rejected', 'superseded'))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_marketplace_claim_tenant_post
      ON marketplace.marketplace_claim (tenant_id, marketplace_post_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_marketplace_claim_tenant_claimant
      ON marketplace.marketplace_claim (tenant_id, claimant_employee_id);
    `);

    // -----------------------------------------------------------------------
    // swap_request (§2.1; org-unit/validation_result columns - ADR-0087)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE marketplace.swap_request (
        id                              uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                       uuid NOT NULL,
        initiator_employee_id           uuid NOT NULL,
        initiator_shift_id              uuid NOT NULL,
        initiator_org_unit_id           uuid NOT NULL,
        target_employee_id              uuid,
        target_shift_id                 uuid,
        target_org_unit_id              uuid,
        status                          varchar(20) NOT NULL DEFAULT 'pending',
        requires_supervisor_approval    boolean NOT NULL DEFAULT true,
        validation_result               jsonb,
        created_at                      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT swap_request_status_check
          CHECK (status IN ('pending', 'pending_approval', 'accepted', 'rejected', 'cancelled', 'superseded')),
        -- A closed swap (target already named) must name both the employee
        -- and the shift together - never one without the other.
        CONSTRAINT swap_request_target_pair_check
          CHECK ((target_employee_id IS NULL) = (target_shift_id IS NULL))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_swap_request_tenant_initiator
      ON marketplace.swap_request (tenant_id, initiator_employee_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_swap_request_tenant_target
      ON marketplace.swap_request (tenant_id, target_employee_id)
      WHERE target_employee_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_swap_request_tenant_status
      ON marketplace.swap_request (tenant_id, status);
    `);

    // -----------------------------------------------------------------------
    // bid_opportunity (§2.1)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE marketplace.bid_opportunity (
        id                       uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                uuid NOT NULL,
        marketplace_post_id      uuid NOT NULL,
        bidding_window_start     timestamptz NOT NULL,
        bidding_window_end       timestamptz NOT NULL,
        ranking_method           varchar(20) NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT bid_opportunity_post_fk
          FOREIGN KEY (marketplace_post_id) REFERENCES marketplace.marketplace_post (id),
        CONSTRAINT bid_opportunity_ranking_method_check
          CHECK (ranking_method IN ('seniority', 'preference_score', 'first_come')),
        CONSTRAINT bid_opportunity_window_check
          CHECK (bidding_window_end > bidding_window_start)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_bid_opportunity_tenant_post
      ON marketplace.bid_opportunity (tenant_id, marketplace_post_id);
    `);
    // Phase 4's close-sweep target: which windows have ended but haven't
    // been ranked/closed yet.
    await queryRunner.query(`
      CREATE INDEX idx_bid_opportunity_tenant_window_end
      ON marketplace.bid_opportunity (tenant_id, bidding_window_end);
    `);

    // -----------------------------------------------------------------------
    // bid (§2.1, §5.1)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE marketplace.bid (
        id                    uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id              uuid NOT NULL,
        bid_opportunity_id     uuid NOT NULL,
        employee_id            uuid NOT NULL,
        rank_score             numeric(10,4),
        rank_position           integer,
        rank_explanation        jsonb,
        submitted_at            timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT bid_opportunity_fk
          FOREIGN KEY (bid_opportunity_id) REFERENCES marketplace.bid_opportunity (id),
        -- One bid per employee per opportunity - the natural real-world
        -- constraint (§5.1's ranking has no meaning for duplicate bids from
        -- the same employee), enforced structurally rather than trusted to
        -- application code alone.
        CONSTRAINT bid_opportunity_employee_unique
          UNIQUE (bid_opportunity_id, employee_id),
        CONSTRAINT bid_rank_position_positive_check
          CHECK (rank_position IS NULL OR rank_position > 0)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_bid_tenant_opportunity
      ON marketplace.bid (tenant_id, bid_opportunity_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_bid_tenant_employee
      ON marketplace.bid (tenant_id, employee_id);
    `);

    // -----------------------------------------------------------------------
    // marketplace_engagement_score (§2.1, §2.2 rule 3, §5.2)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE marketplace.marketplace_engagement_score (
        employee_id                   uuid NOT NULL,
        tenant_id                     uuid NOT NULL,
        points                        integer NOT NULL DEFAULT 0,
        streak_days                   integer NOT NULL DEFAULT 0,
        badges                        jsonb NOT NULL DEFAULT '[]'::jsonb,
        claim_attempt_count_window    integer,
        claim_attempt_window_start    timestamptz,
        PRIMARY KEY (employee_id, tenant_id),
        CONSTRAINT marketplace_engagement_score_non_negative_check
          CHECK (points >= 0 AND streak_days >= 0)
      );
    `);

    // -----------------------------------------------------------------------
    // Row Level Security (ADR-0002, unchanged convention)
    // -----------------------------------------------------------------------
    const tables = [
      'marketplace_post',
      'marketplace_claim',
      'swap_request',
      'bid_opportunity',
      'bid',
      'marketplace_engagement_score',
    ];
    for (const table of tables) {
      await queryRunner.query(`ALTER TABLE marketplace.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON marketplace.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // -----------------------------------------------------------------------
    // Grants - agno_marketplace_app is the runtime role. No table here is
    // append-only (see this file's own doc comment); no DELETE grant on any
    // of them, and no CREATE on the schema at all.
    // -----------------------------------------------------------------------
    await queryRunner.query(`GRANT USAGE ON SCHEMA marketplace TO agno_marketplace_app;`);
    for (const table of tables) {
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON marketplace.${table} TO agno_marketplace_app;`);
    }
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA marketplace FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS marketplace CASCADE;`);
  }
}
