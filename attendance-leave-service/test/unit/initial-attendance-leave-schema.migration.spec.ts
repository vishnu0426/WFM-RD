import { QueryRunner } from 'typeorm';
import { InitialAttendanceLeaveSchema1700000600000 } from '../../src/database/migrations/1700000600000-InitialAttendanceLeaveSchema';

/**
 * No live Postgres in this test run (Phase 1 has no `test/integration/`
 * directory yet - see the design doc's own note that this is a real,
 * flagged follow-up). This spec instead captures every SQL string the
 * migration's `up()` issues against a mock `QueryRunner` and asserts the
 * invariants §2/§2.2/§5.1/ADR-0073/ADR-0074 depend on, so a future edit to
 * this migration can't silently drop the backdated-reason guarantee, the
 * RLS policy on one of the five tables, or widen a grant past
 * least-privilege without a test failing.
 */
describe('InitialAttendanceLeaveSchema1700000600000', () => {
  const TABLES = ['attendance_record', 'leave_type', 'leave_balance', 'leave_request', 'absence_pattern'];

  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;

    const migration = new InitialAttendanceLeaveSchema1700000600000();
    await migration.up(queryRunner);
    return statements;
  }

  it('creates the attendance_leave schema and all five §2.1 tables', async () => {
    const statements = await runUp();
    expect(statements.some((s) => /CREATE SCHEMA IF NOT EXISTS attendance_leave/.test(s))).toBe(true);
    for (const table of TABLES) {
      expect(statements.some((s) => new RegExp(`CREATE TABLE attendance_leave\\.${table}`).test(s))).toBe(true);
    }
  });

  it('enables RLS with a tenant_isolation policy on every table (ADR-0002)', async () => {
    const statements = await runUp();
    for (const table of TABLES) {
      expect(
        statements.some((s) => new RegExp(`ALTER TABLE attendance_leave\\.${table} ENABLE ROW LEVEL SECURITY`).test(s)),
      ).toBe(true);
      expect(
        statements.some((s) => new RegExp(`CREATE POLICY tenant_isolation ON attendance_leave\\.${table}`).test(s)),
      ).toBe(true);
    }
  });

  it('§5.1: makes a backdated request without a reason structurally impossible', async () => {
    const statements = await runUp();
    expect(
      statements.some((s) =>
        /CONSTRAINT leave_request_backdated_reason_required_check\s+CHECK \(NOT is_backdated OR backdated_reason IS NOT NULL\)/.test(
          s,
        ),
      ),
    ).toBe(true);
  });

  it("§2.1: leave_balance's composite PK is exactly (employee_id, leave_type_id, period_start, period_end) - the ADR-0074 lock granularity", async () => {
    const statements = await runUp();
    const createLeaveBalance = statements.find((s) => /CREATE TABLE attendance_leave\.leave_balance/.test(s));
    expect(createLeaveBalance).toBeDefined();
    expect(createLeaveBalance).toMatch(/PRIMARY KEY \(employee_id, leave_type_id, period_start, period_end\)/);
  });

  it('§5.2: leave_type carries a jsonb carryover_rules column from this migration, not a later ALTER', async () => {
    const statements = await runUp();
    const createLeaveType = statements.find((s) => /CREATE TABLE attendance_leave\.leave_type/.test(s));
    expect(createLeaveType).toMatch(/carryover_rules\s+jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  });

  it('ADR-0073: grants are least-privilege - SELECT/INSERT/UPDATE only, never DELETE, no CREATE on the schema', async () => {
    const statements = await runUp();
    for (const table of TABLES) {
      const grant = statements.find((s) =>
        new RegExp(`GRANT .* ON attendance_leave\\.${table} TO agno_attendance_leave_app`).test(s),
      );
      expect(grant).toBeDefined();
      expect(grant).toContain('SELECT');
      expect(grant).toContain('INSERT');
      expect(grant).toContain('UPDATE');
      expect(grant).not.toContain('DELETE');
    }
    expect(statements.some((s) => /GRANT CREATE ON SCHEMA attendance_leave/.test(s))).toBe(false);
  });

  it('down() drops the whole schema (rollback plan)', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new InitialAttendanceLeaveSchema1700000600000();
    await migration.down(queryRunner);
    expect(statements.some((s) => /DROP SCHEMA IF EXISTS attendance_leave CASCADE/.test(s))).toBe(true);
  });
});
