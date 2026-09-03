import { QueryRunner } from 'typeorm';
import { LeaveBalanceCarryoverAppliedFlag1700000900000 } from '../../src/database/migrations/1700000900000-LeaveBalanceCarryoverAppliedFlag';

/** Same mock-QueryRunner pattern as the Phase 1/2/3 migration specs - see their own doc comments. */
describe('LeaveBalanceCarryoverAppliedFlag1700000900000', () => {
  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    await new LeaveBalanceCarryoverAppliedFlag1700000900000().up(queryRunner);
    return statements;
  }

  it('adds carryover_applied as NOT NULL DEFAULT false', async () => {
    const statements = await runUp();
    expect(
      statements.some((s) =>
        /ALTER TABLE attendance_leave\.leave_balance\s+ADD COLUMN carryover_applied boolean NOT NULL DEFAULT false/.test(
          s,
        ),
      ),
    ).toBe(true);
  });

  it("adds a partial index matching the rollover job's own WHERE carryover_applied = false predicate", async () => {
    const statements = await runUp();
    expect(
      statements.some(
        (s) => /CREATE INDEX idx_leave_balance_carryover_pending/.test(s) && /WHERE carryover_applied = false/.test(s),
      ),
    ).toBe(true);
  });

  it('down() drops the index and column, both IF EXISTS-guarded', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    await new LeaveBalanceCarryoverAppliedFlag1700000900000().down(queryRunner);
    expect(statements.every((s) => /IF EXISTS/.test(s))).toBe(true);
    expect(statements).toHaveLength(2);
  });
});
