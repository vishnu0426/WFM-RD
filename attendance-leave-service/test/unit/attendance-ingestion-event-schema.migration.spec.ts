import { QueryRunner } from 'typeorm';
import { AttendanceIngestionEventSchema1700000700000 } from '../../src/database/migrations/1700000700000-AttendanceIngestionEventSchema';

/** Same mock-QueryRunner shape as Phase 1's `initial-attendance-leave-schema.migration.spec.ts` - see that file's own doc comment. */
describe('AttendanceIngestionEventSchema1700000700000', () => {
  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    await new AttendanceIngestionEventSchema1700000700000().up(queryRunner);
    return statements;
  }

  it('creates the table with the (tenant_id, source, source_event_id) dedup unique constraint (ADR-0075)', async () => {
    const statements = await runUp();
    const create = statements.find((s) => /CREATE TABLE attendance_leave\.attendance_ingestion_event/.test(s));
    expect(create).toBeDefined();
    expect(create).toMatch(/UNIQUE \(tenant_id, source, source_event_id\)/);
  });

  it('attendance_record_id is a real same-schema foreign key', async () => {
    const statements = await runUp();
    const create = statements.find((s) => /CREATE TABLE attendance_leave\.attendance_ingestion_event/.test(s));
    expect(create).toMatch(
      /FOREIGN KEY \(attendance_record_id\) REFERENCES attendance_leave\.attendance_record \(id\)/,
    );
  });

  it('enables RLS with a tenant_isolation policy (ADR-0002)', async () => {
    const statements = await runUp();
    expect(
      statements.some((s) =>
        /ALTER TABLE attendance_leave\.attendance_ingestion_event ENABLE ROW LEVEL SECURITY/.test(s),
      ),
    ).toBe(true);
    expect(
      statements.some((s) => /CREATE POLICY tenant_isolation ON attendance_leave\.attendance_ingestion_event/.test(s)),
    ).toBe(true);
  });

  it('ADR-0075: grants stay SELECT/INSERT only, same as every Phase 1 table - no DELETE needed (single-transaction design)', async () => {
    const statements = await runUp();
    const grant = statements.find((s) =>
      /GRANT .* ON attendance_leave\.attendance_ingestion_event TO agno_attendance_leave_app/.test(s),
    );
    expect(grant).toBeDefined();
    expect(grant).toContain('SELECT');
    expect(grant).toContain('INSERT');
    expect(grant).not.toContain('DELETE');
  });

  it('down() drops only this table, not the whole schema', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    await new AttendanceIngestionEventSchema1700000700000().down(queryRunner);
    expect(statements).toEqual(['DROP TABLE IF EXISTS attendance_leave.attendance_ingestion_event;']);
  });
});
