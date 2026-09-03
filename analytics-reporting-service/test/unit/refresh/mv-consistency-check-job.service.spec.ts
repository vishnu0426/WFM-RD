import { MvConsistencyCheckJobService } from '../../../src/refresh/mv-consistency-check-job.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

/**
 * Same hand-rolled `pg.Pool` stub posture as every other refresh-job spec in
 * this module - this test is about the job's own sample/compare/report
 * logic, not about wiring real Postgres connections.
 */
describe('MvConsistencyCheckJobService', () => {
  let primaryPool: { query: jest.Mock };
  let replicaPool: { query: jest.Mock };
  let metrics: MetricsService;
  let service: MvConsistencyCheckJobService;

  beforeEach(() => {
    primaryPool = { query: jest.fn() };
    replicaPool = { query: jest.fn() };
    metrics = new MetricsService();
    service = new MvConsistencyCheckJobService(primaryPool as any, replicaPool as any, metrics);
  });

  async function discrepancyCount(viewName: string): Promise<number> {
    const values = (
      await metrics.getRegistry().getSingleMetric('analytics_consistency_check_discrepancies_total')?.get()
    )?.values;
    return values?.find((v) => v.labels.view_name === viewName)?.value ?? 0;
  }

  describe('checkAdherenceTrendRollup', () => {
    it('records no discrepancy when the fresh source read agrees with the sampled mv row', async () => {
      primaryPool.query.mockResolvedValueOnce({
        rows: [
          {
            tenant_id: 't1',
            period_type: 'day',
            period_start: new Date('2026-08-10T00:00:00Z'),
            period_end: new Date('2026-08-11T00:00:00Z'),
            avg_adherence_pct: '95.00',
            total_major_deviation_count: '2',
            employee_count: '3',
          },
        ],
      });
      replicaPool.query.mockResolvedValueOnce({
        rows: [{ avg_adherence_pct: '95.02', total_major_deviation_count: '2', employee_count: '3' }],
      });

      await service.checkAdherenceTrendRollup();

      expect(await discrepancyCount('mv_adherence_trend_rollup')).toBe(0);
    });

    it('records a discrepancy and logs it when the fresh read disagrees beyond tolerance', async () => {
      primaryPool.query.mockResolvedValueOnce({
        rows: [
          {
            tenant_id: 't1',
            period_type: 'day',
            period_start: new Date('2026-08-10T00:00:00Z'),
            period_end: new Date('2026-08-11T00:00:00Z'),
            avg_adherence_pct: '95.00',
            total_major_deviation_count: '2',
            employee_count: '3',
          },
        ],
      });
      replicaPool.query.mockResolvedValueOnce({
        rows: [{ avg_adherence_pct: '60.00', total_major_deviation_count: '2', employee_count: '3' }],
      });

      await service.checkAdherenceTrendRollup();

      expect(await discrepancyCount('mv_adherence_trend_rollup')).toBe(1);
    });

    it('re-derives the fresh read scoped to the exact sampled group, not every tenant', async () => {
      primaryPool.query.mockResolvedValueOnce({
        rows: [
          {
            tenant_id: 't1',
            period_type: 'week',
            period_start: new Date('2026-08-03T00:00:00Z'),
            period_end: new Date('2026-08-10T00:00:00Z'),
            avg_adherence_pct: '95.00',
            total_major_deviation_count: '2',
            employee_count: '3',
          },
        ],
      });
      replicaPool.query.mockResolvedValueOnce({
        rows: [{ avg_adherence_pct: '95.00', total_major_deviation_count: '2', employee_count: '3' }],
      });

      await service.checkAdherenceTrendRollup();

      expect(replicaPool.query.mock.calls[0][1]).toEqual([
        't1',
        'week',
        new Date('2026-08-03T00:00:00Z'),
        new Date('2026-08-10T00:00:00Z'),
      ]);
    });

    it('logs and swallows a query failure rather than throwing (a bad tick must not take down the process)', async () => {
      primaryPool.query.mockRejectedValueOnce(new Error('connection refused'));

      await expect(service.checkAdherenceTrendRollup()).resolves.toBeUndefined();
    });
  });

  describe('checkForecastAccuracyTrend', () => {
    it('records a discrepancy when avg_mape disagrees beyond tolerance', async () => {
      primaryPool.query.mockResolvedValueOnce({
        rows: [
          {
            tenant_id: 't1',
            org_unit_id: 'ou1',
            period_start: new Date('2026-08-10T00:00:00Z'),
            avg_mape: '0.10',
            avg_bias: '0.02',
            forecast_count: '5',
          },
        ],
      });
      replicaPool.query.mockResolvedValueOnce({ rows: [{ avg_mape: '0.90', avg_bias: '0.02', forecast_count: '5' }] });

      await service.checkForecastAccuracyTrend();

      expect(await discrepancyCount('mv_forecast_accuracy_trend')).toBe(1);
    });
  });

  describe('checkCostVsBudget', () => {
    it('records no discrepancy when hours/days agree within tolerance', async () => {
      primaryPool.query.mockResolvedValueOnce({
        rows: [
          {
            tenant_id: 't1',
            cost_center: 'cc1',
            period_start: new Date('2026-08-01T00:00:00Z'),
            scheduled_hours: '160.00',
            overtime_hours: '10.00',
            approved_leave_days: '2.00',
          },
        ],
      });
      replicaPool.query.mockResolvedValueOnce({
        rows: [{ scheduled_hours: '160.00', overtime_hours: '10.00', approved_leave_days: '2.00' }],
      });

      await service.checkCostVsBudget();

      expect(await discrepancyCount('mv_cost_vs_budget')).toBe(0);
    });

    it('records a discrepancy when scheduled_hours disagrees beyond tolerance', async () => {
      primaryPool.query.mockResolvedValueOnce({
        rows: [
          {
            tenant_id: 't1',
            cost_center: 'cc1',
            period_start: new Date('2026-08-01T00:00:00Z'),
            scheduled_hours: '160.00',
            overtime_hours: '10.00',
            approved_leave_days: '2.00',
          },
        ],
      });
      replicaPool.query.mockResolvedValueOnce({
        rows: [{ scheduled_hours: '20.00', overtime_hours: '10.00', approved_leave_days: '2.00' }],
      });

      await service.checkCostVsBudget();

      expect(await discrepancyCount('mv_cost_vs_budget')).toBe(1);
    });
  });

  describe('checkAttritionBySite', () => {
    it('records no discrepancy when terminations_count matches exactly', async () => {
      primaryPool.query.mockResolvedValueOnce({
        rows: [
          {
            tenant_id: 't1',
            site_org_unit_id: 's1',
            period_start: new Date('2026-08-01T00:00:00Z'),
            terminations_count: '4',
          },
        ],
      });
      replicaPool.query.mockResolvedValueOnce({ rows: [{ terminations_count: '4' }] });

      await service.checkAttritionBySite();

      expect(await discrepancyCount('mv_attrition_by_site')).toBe(0);
    });

    it('records a discrepancy when terminations_count disagrees beyond tolerance', async () => {
      primaryPool.query.mockResolvedValueOnce({
        rows: [
          {
            tenant_id: 't1',
            site_org_unit_id: 's1',
            period_start: new Date('2026-08-01T00:00:00Z'),
            terminations_count: '4',
          },
        ],
      });
      replicaPool.query.mockResolvedValueOnce({ rows: [{ terminations_count: '40' }] });

      await service.checkAttritionBySite();

      expect(await discrepancyCount('mv_attrition_by_site')).toBe(1);
    });
  });

  describe('tick', () => {
    it('runs all four view checks', async () => {
      primaryPool.query.mockResolvedValue({ rows: [] });

      await service.tick();

      expect(primaryPool.query).toHaveBeenCalledTimes(4);
    });

    it('is guarded against overlapping runs (a second tick during a slow first one issues no new queries)', async () => {
      let resolveFirst: (value: { rows: never[] }) => void = () => undefined;
      primaryPool.query.mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)));
      primaryPool.query.mockResolvedValue({ rows: [] });

      const first = service.tick();
      // The first tick's Promise.all synchronously starts all four checks,
      // each issuing its own primaryPool.query call before suspending on
      // its own await - so call count is 4, not 1, even though one of
      // those four checks hasn't resolved yet.
      const callsAfterFirstStarted = primaryPool.query.mock.calls.length;

      await service.tick();

      expect(primaryPool.query).toHaveBeenCalledTimes(callsAfterFirstStarted);
      resolveFirst({ rows: [] });
      await first;
    });
  });
});
