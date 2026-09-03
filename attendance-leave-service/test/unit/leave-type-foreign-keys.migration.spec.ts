import { QueryRunner } from 'typeorm';
import { LeaveTypeForeignKeys1700000800000 } from '../../src/database/migrations/1700000800000-LeaveTypeForeignKeys';

/** Same mock-QueryRunner pattern as the Phase 1/2 migration specs - see their own doc comments. */
describe('LeaveTypeForeignKeys1700000800000', () => {
  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    await new LeaveTypeForeignKeys1700000800000().up(queryRunner);
    return statements;
  }

  it('adds real foreign keys from leave_balance/leave_request to leave_type (same-schema, ADR-0075 precedent)', async () => {
    const statements = await runUp();
    expect(
      statements.some((s) =>
        /ALTER TABLE attendance_leave\.leave_balance\s+ADD CONSTRAINT leave_balance_leave_type_id_fkey\s+FOREIGN KEY \(leave_type_id\) REFERENCES attendance_leave\.leave_type \(id\)/.test(
          s,
        ),
      ),
    ).toBe(true);
    expect(
      statements.some((s) =>
        /ALTER TABLE attendance_leave\.leave_request\s+ADD CONSTRAINT leave_request_leave_type_id_fkey\s+FOREIGN KEY \(leave_type_id\) REFERENCES attendance_leave\.leave_type \(id\)/.test(
          s,
        ),
      ),
    ).toBe(true);
  });

  it('adds supporting indexes on both leave_type_id columns', async () => {
    const statements = await runUp();
    expect(statements.some((s) => /CREATE INDEX idx_leave_balance_leave_type_id/.test(s))).toBe(true);
    expect(statements.some((s) => /CREATE INDEX idx_leave_request_leave_type_id/.test(s))).toBe(true);
  });

  it('down() drops both indexes and constraints, all IF EXISTS-guarded', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    await new LeaveTypeForeignKeys1700000800000().down(queryRunner);
    expect(statements.every((s) => /IF EXISTS/.test(s))).toBe(true);
    expect(statements).toHaveLength(4);
  });
});
