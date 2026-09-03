import { QueryRunner } from 'typeorm';
import { InitialMarketplaceSchema1700001000000 } from '../../src/database/migrations/1700001000000-InitialMarketplaceSchema';

/**
 * No live Postgres in this test run - same posture as every other service's
 * Phase 1 migration spec. Captures every SQL string the migration's `up()`
 * issues against a mock `QueryRunner` and asserts the invariants §2/§2.2/
 * §5.1/§5.2/ADR-0083 depend on, so a future edit to this migration can't
 * silently drop the RLS policy on one of the six tables, collapse
 * pending_validation/pending_approval into one status, or widen a grant
 * past least-privilege without a test failing.
 */
describe('InitialMarketplaceSchema1700001000000', () => {
  const TABLES = [
    'marketplace_post',
    'marketplace_claim',
    'swap_request',
    'bid_opportunity',
    'bid',
    'marketplace_engagement_score',
  ];

  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;

    const migration = new InitialMarketplaceSchema1700001000000();
    await migration.up(queryRunner);
    return statements;
  }

  it('creates the marketplace schema and all six §2.1 tables', async () => {
    const statements = await runUp();
    expect(statements.some((s) => /CREATE SCHEMA IF NOT EXISTS marketplace/.test(s))).toBe(true);
    for (const table of TABLES) {
      // `(?!_)` guards against `bid` loosely matching `bid_opportunity`'s own
      // CREATE TABLE statement - the only prefix collision among these six
      // table names.
      expect(statements.some((s) => new RegExp(`CREATE TABLE marketplace\\.${table}(?!_)`).test(s))).toBe(true);
    }
  });

  it('enables RLS with a tenant_isolation policy on every table (ADR-0002)', async () => {
    const statements = await runUp();
    for (const table of TABLES) {
      expect(
        statements.some((s) => new RegExp(`ALTER TABLE marketplace\\.${table} ENABLE ROW LEVEL SECURITY`).test(s)),
      ).toBe(true);
      expect(
        statements.some((s) => new RegExp(`CREATE POLICY tenant_isolation ON marketplace\\.${table}(?!_)`).test(s)),
      ).toBe(true);
    }
  });

  it("§2.2 rule 2: pending_validation and pending_approval are both distinct values in marketplace_claim's status check", async () => {
    const statements = await runUp();
    const createClaim = statements.find((s) => /CREATE TABLE marketplace\.marketplace_claim/.test(s));
    expect(createClaim).toMatch(/'pending_validation'/);
    expect(createClaim).toMatch(/'pending_approval'/);
  });

  it('§5.1: bid carries rank_position and rank_explanation columns from this migration, not a later ALTER', async () => {
    const statements = await runUp();
    const createBid = statements.find((s) => /CREATE TABLE marketplace\.bid\s*\(/.test(s));
    expect(createBid).toMatch(/rank_position\s+integer/);
    expect(createBid).toMatch(/rank_explanation\s+jsonb/);
  });

  it('§5.2: marketplace_engagement_score carries claim_attempt_count_window/claim_attempt_window_start from this migration', async () => {
    const statements = await runUp();
    const createScore = statements.find((s) => /CREATE TABLE marketplace\.marketplace_engagement_score/.test(s));
    expect(createScore).toMatch(/claim_attempt_count_window\s+integer/);
    expect(createScore).toMatch(/claim_attempt_window_start\s+timestamptz/);
  });

  it('marketplace_claim.marketplace_post_id and bid.bid_opportunity_id are real intra-schema foreign keys', async () => {
    const statements = await runUp();
    const createClaim = statements.find((s) => /CREATE TABLE marketplace\.marketplace_claim/.test(s));
    expect(createClaim).toMatch(/FOREIGN KEY \(marketplace_post_id\) REFERENCES marketplace\.marketplace_post \(id\)/);
    const createBid = statements.find((s) => /CREATE TABLE marketplace\.bid\s*\(/.test(s));
    expect(createBid).toMatch(/FOREIGN KEY \(bid_opportunity_id\) REFERENCES marketplace\.bid_opportunity \(id\)/);
  });

  it('ADR-0083: grants are least-privilege - SELECT/INSERT/UPDATE only, never DELETE, no CREATE on the schema', async () => {
    const statements = await runUp();
    for (const table of TABLES) {
      const grant = statements.find((s) =>
        new RegExp(`GRANT .* ON marketplace\\.${table} TO agno_marketplace_app`).test(s),
      );
      expect(grant).toBeDefined();
      expect(grant).not.toMatch(/DELETE/);
      expect(grant).not.toMatch(/CREATE/);
    }
    expect(statements.some((s) => /REVOKE ALL ON ALL TABLES IN SCHEMA marketplace FROM PUBLIC/.test(s))).toBe(true);
  });

  it('drops the schema on down()', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new InitialMarketplaceSchema1700001000000();
    await migration.down(queryRunner);
    expect(statements.some((s) => /DROP SCHEMA IF EXISTS marketplace CASCADE/.test(s))).toBe(true);
  });
});
