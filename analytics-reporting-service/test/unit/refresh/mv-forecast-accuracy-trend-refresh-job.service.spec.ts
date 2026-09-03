import { MvForecastAccuracyTrendRefreshJobService } from '../../../src/refresh/mv-forecast-accuracy-trend-refresh-job.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

describe('MvForecastAccuracyTrendRefreshJobService', () => {
  let replicaPool: { query: jest.Mock };
  let primaryPool: { connect: jest.Mock; query: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let service: MvForecastAccuracyTrendRefreshJobService;

  beforeEach(() => {
    replicaPool = { query: jest.fn() };
    client = { query: jest.fn().mockResolvedValue(undefined), release: jest.fn() };
    primaryPool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() };
    service = new MvForecastAccuracyTrendRefreshJobService(
      primaryPool as any,
      replicaPool as any,
      new MetricsService(),
    );
  });

  it('reads forecast_accuracy_log from the replica pool, filtering out rows with no mape', async () => {
    replicaPool.query.mockResolvedValueOnce({ rows: [] });

    await service.refresh();

    expect(replicaPool.query.mock.calls[0][0]).toContain('FROM forecasting.forecast_accuracy_log');
    expect(replicaPool.query.mock.calls[0][0]).toContain('WHERE mape IS NOT NULL');
  });

  it('upserts with period_start cast to timestamptz before the interval arithmetic (a real bug caught in verification)', async () => {
    replicaPool.query.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: 't1',
          org_unit_id: 'ou1',
          period_start: new Date('2026-08-10T00:00:00Z'),
          avg_mape: '0.0665',
          avg_bias: '0.0',
          forecast_count: '2',
        },
      ],
    });

    await service.refresh();

    const insertCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO analytics_mv.mv_forecast_accuracy_trend'),
    );
    expect(insertCall?.[0]).toContain('$3::timestamptz, $3::timestamptz + interval');
    expect(insertCall?.[1]).toEqual(['t1', 'ou1', expect.any(Date), '0.0665', '0.0', '2']);
  });

  it('data_as_of is the max period_start observed, null when no rows', async () => {
    replicaPool.query.mockResolvedValueOnce({ rows: [] });

    await service.refresh();

    const lineageUpdate = client.query.mock.calls.find(([sql]) => sql.includes('UPDATE analytics_mv.mv_lineage'));
    expect(lineageUpdate?.[1]).toEqual([null, 'mv_forecast_accuracy_trend']);
  });

  it('marks mv_lineage failed and rethrows when the source read itself fails', async () => {
    replicaPool.query.mockRejectedValueOnce(new Error('replica unreachable'));

    await expect(service.refresh()).rejects.toThrow('replica unreachable');
    // The transaction never opened - primaryPool.query (not client.query) is
    // used for the out-of-band failure mark, exercised via tick() instead.
    expect(primaryPool.connect).not.toHaveBeenCalled();
  });

  it('tick() marks mv_lineage.last_run_status failed via the primary pool when refresh throws', async () => {
    replicaPool.query.mockRejectedValueOnce(new Error('replica unreachable'));

    await service.tick();

    expect(primaryPool.query).toHaveBeenCalledWith(expect.stringContaining("last_run_status = 'failed'"), [
      'mv_forecast_accuracy_trend',
    ]);
  });
});
