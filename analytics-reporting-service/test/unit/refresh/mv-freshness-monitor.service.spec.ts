import { MvFreshnessMonitorService } from '../../../src/refresh/mv-freshness-monitor.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

describe('MvFreshnessMonitorService', () => {
  let primaryPool: { query: jest.Mock };
  let replicaPool: { query: jest.Mock };
  let metrics: MetricsService;
  let service: MvFreshnessMonitorService;

  beforeEach(() => {
    primaryPool = { query: jest.fn() };
    replicaPool = { query: jest.fn() };
    metrics = new MetricsService();
    service = new MvFreshnessMonitorService(primaryPool as any, replicaPool as any, metrics);
  });

  async function gaugeValues(name: string): Promise<Array<{ labels: Record<string, string>; value: number }>> {
    const metric = await metrics.getRegistry().getSingleMetric(name)?.get();
    return (metric?.values as Array<{ labels: Record<string, string>; value: number }>) ?? [];
  }

  it('sets analytics_mv_refresh_lag_seconds per view, skipping a view that has never been refreshed', async () => {
    const now = Date.now();
    primaryPool.query.mockResolvedValueOnce({
      rows: [
        { view_name: 'mv_adherence_trend_rollup', refresh_cadence: 'daily', refreshed_at: new Date(now - 1000) },
        { view_name: 'mv_cost_vs_budget', refresh_cadence: 'daily', refreshed_at: null },
      ],
    });
    replicaPool.query.mockResolvedValueOnce({ rows: [{ in_recovery: false, lag_seconds: null }] });

    await service.sample();

    const values = await gaugeValues('analytics_mv_refresh_lag_seconds');
    expect(values).toHaveLength(1);
    expect(values[0].labels).toEqual({ view_name: 'mv_adherence_trend_rollup' });
    // Refreshed ~1s ago, daily cadence (86400s) - lag is deeply negative
    // (not remotely due), not zero/positive.
    expect(values[0].value).toBeLessThan(-86300);
  });

  it("skips calling .set() when pointed at a primary, not a real replica (pg_is_in_recovery() false) - reads prom-client's own default 0 for this unlabeled Gauge, not a value this code chose", async () => {
    primaryPool.query.mockResolvedValueOnce({ rows: [] });
    replicaPool.query.mockResolvedValueOnce({ rows: [{ in_recovery: false, lag_seconds: null }] });

    await service.sample();

    // Disclosed prom-client limitation (see this service's own doc
    // comment): an unlabeled Gauge initializes to 0 at registration, not
    // "absent," so this reads 0 even though .set() was never called for
    // it. A labeled Gauge (analytics_mv_refresh_lag_seconds, tested above)
    // does not have this problem.
    const values = await gaugeValues('analytics_replica_lag_seconds');
    expect(values).toEqual([expect.objectContaining({ value: 0 })]);
  });

  it('sets analytics_replica_lag_seconds when genuinely in recovery', async () => {
    primaryPool.query.mockResolvedValueOnce({ rows: [] });
    replicaPool.query.mockResolvedValueOnce({ rows: [{ in_recovery: true, lag_seconds: 0.42 }] });

    await service.sample();

    const values = await gaugeValues('analytics_replica_lag_seconds');
    expect(values).toEqual([expect.objectContaining({ value: 0.42 })]);
  });

  it('does not throw when either query fails - a monitoring sample failing must not crash the process', async () => {
    primaryPool.query.mockRejectedValueOnce(new Error('primary unreachable'));
    replicaPool.query.mockRejectedValueOnce(new Error('replica unreachable'));

    await expect(service.sample()).resolves.toBeUndefined();
  });
});
