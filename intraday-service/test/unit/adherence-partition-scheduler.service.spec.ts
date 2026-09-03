import { AdherencePartitionSchedulerService } from '../../src/adherence/adherence-partition-scheduler.service';

type QueryCall = [string, unknown[]?];

describe('AdherencePartitionSchedulerService.tick', () => {
  const makePool = (existingNames: string[] = [], oldPartitionNames: string[] = ['adherence_event_2020_01_01']) => ({
    query: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT 1 FROM pg_class')) {
        const name = (params as string[])[0];
        return Promise.resolve({ rowCount: existingNames.includes(name) ? 1 : 0, rows: [] });
      }
      if (sql.includes('CREATE TABLE')) {
        return Promise.resolve({});
      }
      if (sql.includes('pg_inherits')) {
        return Promise.resolve({ rows: oldPartitionNames.map((relname) => ({ relname })) });
      }
      if (sql.includes('DROP TABLE')) {
        return Promise.resolve({});
      }
      return Promise.resolve({ rows: [] });
    }),
  });

  it('creates partitions for today through the create-ahead window that do not already exist', async () => {
    const pool = makePool([]);
    const scheduler = new AdherencePartitionSchedulerService(pool as never);

    await scheduler.tick();

    const createCalls = (pool.query.mock.calls as QueryCall[]).filter(([sql]) => sql.includes('CREATE TABLE'));
    expect(createCalls).toHaveLength(3); // today, +1, +2
  });

  it('skips creating a partition that already exists', async () => {
    const todayName = `adherence_event_${new Date().toISOString().slice(0, 10).replace(/-/g, '_')}`;
    const pool = makePool([todayName]);
    const scheduler = new AdherencePartitionSchedulerService(pool as never);

    await scheduler.tick();

    const createCalls = (pool.query.mock.calls as QueryCall[]).filter(([sql]) => sql.includes('CREATE TABLE'));
    expect(createCalls).toHaveLength(2); // +1, +2 only
  });

  it('drops every partition pg_inherits reports as older than the retention cutoff', async () => {
    const pool = makePool([], ['adherence_event_2020_01_01', 'adherence_event_2020_01_02']);
    const scheduler = new AdherencePartitionSchedulerService(pool as never);

    await scheduler.tick();

    const dropCalls = (pool.query.mock.calls as QueryCall[]).filter(([sql]) => sql.includes('DROP TABLE'));
    expect(dropCalls).toHaveLength(2);
  });

  it('a concurrent tick while one is already running is a no-op (re-entrancy guard)', async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const pool = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT 1 FROM pg_class')) {
          await gate;
          return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
      }),
    };
    const scheduler = new AdherencePartitionSchedulerService(pool as never);

    const first = scheduler.tick();
    const second = scheduler.tick();
    resolveFirst?.();
    await Promise.all([first, second]);

    const existsCalls = (pool.query.mock.calls as QueryCall[]).filter(([sql]) =>
      sql.includes('SELECT 1 FROM pg_class'),
    );
    expect(existsCalls).toHaveLength(3); // only the first tick's 3 offset checks ran
  });
});
