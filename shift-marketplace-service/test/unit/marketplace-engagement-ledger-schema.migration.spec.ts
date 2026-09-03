import { QueryRunner } from 'typeorm';
import { MarketplaceEngagementLedgerSchema1700002000000 } from '../../src/database/migrations/1700002000000-MarketplaceEngagementLedgerSchema';

/**
 * No live Postgres in this test run - same posture as
 * `initial-marketplace-schema.migration.spec.ts`. Captures every SQL
 * string this migration's `up()` issues and asserts the invariants
 * §2.2 rule 3/ADR-0091 depend on.
 */
describe('MarketplaceEngagementLedgerSchema1700002000000', () => {
  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;

    const migration = new MarketplaceEngagementLedgerSchema1700002000000();
    await migration.up(queryRunner);
    return statements;
  }

  it('adds last_engagement_date to the existing marketplace_engagement_score table, not a new one', async () => {
    const statements = await runUp();
    expect(
      statements.some((s) =>
        /ALTER TABLE marketplace\.marketplace_engagement_score\s+ADD COLUMN last_engagement_date date/.test(s),
      ),
    ).toBe(true);
  });

  it('creates marketplace_engagement_event with the full ledger shape', async () => {
    const statements = await runUp();
    const create = statements.find((s) => /CREATE TABLE marketplace\.marketplace_engagement_event/.test(s));
    expect(create).toBeDefined();
    expect(create).toMatch(/tenant_id\s+uuid NOT NULL/);
    expect(create).toMatch(/employee_id\s+uuid NOT NULL/);
    expect(create).toMatch(/event_type\s+varchar/);
    expect(create).toMatch(/reference_id\s+uuid NOT NULL/);
    expect(create).toMatch(/points_delta\s+integer NOT NULL/);
    expect(create).toMatch(/streak_days_after\s+integer NOT NULL/);
    expect(create).toMatch(/badges_awarded\s+jsonb/);
    expect(create).toMatch(/CHECK \(event_type IN \('claim_approved', 'swap_executed'\)\)/);
  });

  it('enables RLS with a tenant_isolation policy on the ledger table (ADR-0002)', async () => {
    const statements = await runUp();
    expect(
      statements.some((s) => /ALTER TABLE marketplace\.marketplace_engagement_event ENABLE ROW LEVEL SECURITY/.test(s)),
    ).toBe(true);
    expect(
      statements.some((s) => /CREATE POLICY tenant_isolation ON marketplace\.marketplace_engagement_event/.test(s)),
    ).toBe(true);
  });

  it('is append-only: grants SELECT, INSERT only - no UPDATE, no DELETE', async () => {
    const statements = await runUp();
    const grant = statements.find((s) =>
      /GRANT .* ON marketplace\.marketplace_engagement_event TO agno_marketplace_app/.test(s),
    );
    expect(grant).toBeDefined();
    expect(grant).toMatch(/GRANT SELECT, INSERT ON/);
    expect(grant).not.toMatch(/UPDATE/);
    expect(grant).not.toMatch(/DELETE/);
  });

  it('drops the ledger table and the added column on down()', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new MarketplaceEngagementLedgerSchema1700002000000();
    await migration.down(queryRunner);
    expect(statements.some((s) => /DROP TABLE IF EXISTS marketplace\.marketplace_engagement_event/.test(s))).toBe(true);
    expect(
      statements.some((s) =>
        /ALTER TABLE marketplace\.marketplace_engagement_score\s+DROP COLUMN IF EXISTS last_engagement_date/.test(s),
      ),
    ).toBe(true);
  });
});
