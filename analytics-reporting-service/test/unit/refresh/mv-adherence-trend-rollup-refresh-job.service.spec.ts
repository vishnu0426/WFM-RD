import { MvAdherenceTrendRollupRefreshJobService } from '../../../src/refresh/mv-adherence-trend-rollup-refresh-job.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

/**
 * Constructed directly, with hand-rolled `pg.Pool`/`PoolClient` stubs - same
 * posture as `adherence-daily-rollup-job.service.spec.ts`'s own doc
 * comment: this test is about the job's own query/upsert/transaction logic,
 * not about wiring real Postgres connections.
 */
describe('MvAdherenceTrendRollupRefreshJobService', () => {
  let replicaPool: { query: jest.Mock };
  let primaryPool: { connect: jest.Mock; query: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let service: MvAdherenceTrendRollupRefreshJobService;
  let metrics: MetricsService;

  beforeEach(() => {
    replicaPool = { query: jest.fn() };
    client = { query: jest.fn().mockResolvedValue(undefined), release: jest.fn() };
    primaryPool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() };
    metrics = new MetricsService();
    service = new MvAdherenceTrendRollupRefreshJobService(primaryPool as any, replicaPool as any, metrics);
  });

  it('reads the source aggregate from the replica pool, not the primary', async () => {
    replicaPool.query.mockResolvedValueOnce({ rows: [] });

    await service.refresh();

    expect(replicaPool.query).toHaveBeenCalledTimes(1);
    expect(replicaPool.query.mock.calls[0][0]).toContain('FROM compliance.adherence_score');
    expect(primaryPool.query).not.toHaveBeenCalledWith(expect.stringContaining('adherence_score'));
  });

  it('upserts every returned row via the primary pool inside one transaction', async () => {
    replicaPool.query.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: 't1',
          period_type: 'day',
          period_start: new Date('2026-08-10T00:00:00Z'),
          period_end: new Date('2026-08-11T00:00:00Z'),
          avg_adherence_pct: '95.50',
          total_major_deviation_count: '2',
          employee_count: '3',
          max_computed_at: new Date('2026-08-11T01:00:00Z'),
        },
      ],
    });

    await service.refresh();

    const calls = client.query.mock.calls.map(([sql]) => sql);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toContain('INSERT INTO analytics_mv.mv_adherence_trend_rollup');
    expect(client.query.mock.calls[1][1]).toEqual(['t1', 'day', expect.any(Date), expect.any(Date), '95.50', '2', '3']);
    expect(calls[calls.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('uses max(computed_at) - never period_end - as data_as_of, since period_end can be a future nominal boundary', async () => {
    replicaPool.query.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: 't1',
          period_type: 'month',
          period_start: new Date('2026-08-01T00:00:00Z'),
          // A month period's nominal end can be later than "now" for an
          // in-progress month - exactly the real bug this test guards
          // against regressing.
          period_end: new Date('2099-08-31T00:00:00Z'),
          avg_adherence_pct: '90.00',
          total_major_deviation_count: '0',
          employee_count: '1',
          max_computed_at: new Date('2026-08-11T09:00:00Z'),
        },
      ],
    });

    await service.refresh();

    const lineageUpdate = client.query.mock.calls.find(([sql]) => sql.includes('UPDATE analytics_mv.mv_lineage'));
    expect(lineageUpdate?.[1][0]).toEqual(new Date('2026-08-11T09:00:00Z'));
  });

  it('leaves data_as_of untouched (COALESCE) when the replica returns zero rows', async () => {
    replicaPool.query.mockResolvedValueOnce({ rows: [] });

    await service.refresh();

    const lineageUpdate = client.query.mock.calls.find(([sql]) => sql.includes('UPDATE analytics_mv.mv_lineage'));
    expect(lineageUpdate?.[1][0]).toBeNull();
    expect(lineageUpdate?.[0]).toContain('COALESCE($1, data_as_of)');
  });

  it('rolls back and rethrows if an upsert fails mid-transaction', async () => {
    replicaPool.query.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: 't1',
          period_type: 'day',
          period_start: new Date(),
          period_end: new Date(),
          avg_adherence_pct: '1.00',
          total_major_deviation_count: '0',
          employee_count: '1',
          max_computed_at: new Date(),
        },
      ],
    });
    client.query.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO analytics_mv.mv_adherence_trend_rollup')) {
        return Promise.reject(new Error('constraint violation'));
      }
      return Promise.resolve(undefined);
    });

    await expect(service.refresh()).rejects.toThrow('constraint violation');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('tick() records a completed run on success', async () => {
    replicaPool.query.mockResolvedValueOnce({ rows: [] });

    await service.tick();

    const runsTotal = (await metrics.getRegistry().getSingleMetric('analytics_mv_refresh_job_runs_total')?.get())
      ?.values;
    expect(runsTotal).toEqual([
      expect.objectContaining({ labels: { view_name: 'mv_adherence_trend_rollup', result: 'completed' }, value: 1 }),
    ]);
  });

  it('tick() is guarded against overlapping runs (a slow tick does not start a second one)', async () => {
    let resolveQuery: (value: { rows: never[] }) => void = () => undefined;
    replicaPool.query.mockReturnValueOnce(new Promise((resolve) => (resolveQuery = resolve)));

    const first = service.tick();
    await service.tick(); // should return immediately without calling replicaPool.query again

    expect(replicaPool.query).toHaveBeenCalledTimes(1);
    resolveQuery({ rows: [] });
    await first;
  });
});
