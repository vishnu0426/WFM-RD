import { QueryRunner } from 'typeorm';
import { SeedPlatformDefaultRetentionPolicy1700003100000 } from '../../src/database/migrations/1700003100000-SeedPlatformDefaultRetentionPolicy';

describe('SeedPlatformDefaultRetentionPolicy1700003100000', () => {
  async function runMigration(direction: 'up' | 'down'): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;

    const migration = new SeedPlatformDefaultRetentionPolicy1700003100000();
    await migration[direction](queryRunner);
    return statements;
  }

  it('inserts exactly one platform-default (tenant_id NULL) US row on up()', async () => {
    const statements = await runMigration('up');
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/INSERT INTO compliance\.retention_policy/);
    expect(statements[0]).toMatch(/tenant_id, jurisdiction, retention_years/);
    expect(statements[0]).toContain("NULL, 'US', 3");
  });

  it('deletes only the platform-default US row on down(), not any tenant-scoped override', async () => {
    const statements = await runMigration('down');
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/DELETE FROM compliance\.retention_policy/);
    expect(statements[0]).toContain('tenant_id IS NULL');
    expect(statements[0]).toContain("jurisdiction = 'US'");
  });
});
