import { MetricQueryEngineService } from '../../../src/analytics/metric-query-engine.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { MetricCostTier } from '../../../src/analytics/entities/metric-definition.entity';
import { MetricNotFoundError, MetricSourceNotAllowedError } from '../../../src/analytics/errors/metric-not-found.error';

function buildDefinition(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'metric-1',
    tenantId: null,
    name: 'adherence_trend',
    calculationDefinition: {
      sourceView: 'mv_adherence_trend_rollup',
      valueColumn: 'avg_adherence_pct',
      dimensions: ['period_type'],
    },
    category: 'attendance',
    estimatedCostTier: MetricCostTier.CHEAP,
    ...overrides,
  };
}

describe('MetricQueryEngineService', () => {
  let dataSource: { transaction: jest.Mock };
  let manager: { findOne: jest.Mock; query: jest.Mock };
  let replicaPool: { connect: jest.Mock };
  let replicaClient: { query: jest.Mock; release: jest.Mock };
  let metrics: MetricsService;
  let service: MetricQueryEngineService;

  beforeEach(() => {
    manager = { findOne: jest.fn(), query: jest.fn().mockResolvedValue(undefined) };
    dataSource = { transaction: jest.fn((work: (m: unknown) => unknown) => work(manager)) };
    replicaClient = { query: jest.fn(), release: jest.fn() };
    replicaPool = { connect: jest.fn().mockResolvedValue(replicaClient) };
    metrics = new MetricsService();
    service = new MetricQueryEngineService(dataSource as any, replicaPool as any, metrics);

    // withTenantScopedClient's own BEGIN/set_config/COMMIT calls - resolve
    // trivially so tests can focus on the SELECT calls specifically.
    replicaClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SELECT set_config')) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('throws MetricNotFoundError when no tenant-specific or platform-default definition exists', async () => {
    manager.findOne.mockResolvedValue(null);

    await expect(service.query('tenant-1', 'unknown_metric')).rejects.toThrow(MetricNotFoundError);
  });

  it('prefers a tenant-specific MetricDefinition over the platform default when both exist', async () => {
    const tenantSpecific = buildDefinition({ tenantId: 'tenant-1' });
    manager.findOne.mockResolvedValueOnce(tenantSpecific);

    await service.query('tenant-1', 'adherence_trend');

    expect(manager.findOne).toHaveBeenCalledTimes(1); // never falls through to the platform-default lookup
  });

  it('falls back to the platform default when no tenant-specific row exists', async () => {
    manager.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(buildDefinition());

    await service.query('tenant-1', 'adherence_trend');

    expect(manager.findOne).toHaveBeenCalledTimes(2);
  });

  it('rejects a calculationDefinition whose sourceView is not in the whitelist, even for a platform-default row', async () => {
    manager.findOne.mockResolvedValueOnce(
      buildDefinition({ calculationDefinition: { sourceView: 'not_a_real_table', valueColumn: 'x' } }),
    );

    await expect(service.query('tenant-1', 'adherence_trend')).rejects.toThrow(MetricSourceNotAllowedError);
  });

  it("rejects a calculationDefinition whose valueColumn is not on that view's whitelist", async () => {
    manager.findOne.mockResolvedValueOnce(
      buildDefinition({
        calculationDefinition: { sourceView: 'mv_adherence_trend_rollup', valueColumn: 'sql_injection; DROP TABLE x' },
      }),
    );

    await expect(service.query('tenant-1', 'adherence_trend')).rejects.toThrow(MetricSourceNotAllowedError);
  });

  it('reads from the replica pool, never the primary DataSource, for the actual row data', async () => {
    manager.findOne.mockResolvedValueOnce(buildDefinition());
    replicaClient.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM analytics_mv.mv_adherence_trend_rollup')) {
        return Promise.resolve({
          rows: [{ period_start: new Date('2026-08-01'), period_end: new Date('2026-08-02'), value: '95.5' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const results = await service.query('tenant-1', 'adherence_trend');

    expect(results).toEqual([
      expect.objectContaining({ metric: 'adherence_trend', value: 95.5, comparisonPeriodValue: null, trend: null }),
    ]);
  });

  it('returns every row as a real result when fewer rows exist than the requested limit (the off-by-one bug caught in real verification)', async () => {
    manager.findOne.mockResolvedValueOnce(buildDefinition());
    replicaClient.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM analytics_mv.mv_adherence_trend_rollup')) {
        // Only 1 row exists, even though the query asked for limit+1 (13).
        return Promise.resolve({
          rows: [{ period_start: new Date('2026-08-01'), period_end: new Date('2026-08-02'), value: '26' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const results = await service.query('tenant-1', 'adherence_trend');

    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(26);
    expect(results[0].comparisonPeriodValue).toBeNull();
  });

  it('drops the extra fetched row (limit+1) once a real comparison row exists, returning only `limit` results', async () => {
    manager.findOne.mockResolvedValueOnce(buildDefinition());
    replicaClient.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM analytics_mv.mv_adherence_trend_rollup')) {
        return Promise.resolve({
          rows: [
            { period_start: new Date('2026-08-03'), period_end: new Date('2026-08-04'), value: '10' },
            { period_start: new Date('2026-08-02'), period_end: new Date('2026-08-03'), value: '20' },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const results = await service.query('tenant-1', 'adherence_trend', { limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(10);
    expect(results[0].comparisonPeriodValue).toBe(20);
    expect(results[0].trend).toBe('down');
  });

  it("only applies a dimension filter listed in that view's own allowedDimensions", async () => {
    manager.findOne.mockResolvedValueOnce(buildDefinition()); // mv_adherence_trend_rollup only allows period_type
    let capturedSql = '';
    replicaClient.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM analytics_mv.mv_adherence_trend_rollup')) {
        capturedSql = sql;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await service.query('tenant-1', 'adherence_trend', { costCenter: 'CC-100', periodType: 'month' });

    expect(capturedSql).toContain('period_type = $1::varchar');
    expect(capturedSql).not.toContain('cost_center'); // not an allowed dimension on this view
  });

  it('reads dataAsOf from mv_lineage keyed by the sourceView name', async () => {
    manager.findOne.mockResolvedValueOnce(buildDefinition());
    replicaClient.query.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('FROM analytics_mv.mv_lineage')) {
        expect(params).toEqual(['mv_adherence_trend_rollup']);
        return Promise.resolve({ rows: [{ data_as_of: new Date('2026-08-11T00:00:00Z') }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const results = await service.query('tenant-1', 'adherence_trend');
    // no rows from the source view - dataAsOf still resolvable but no results to attach it to
    expect(results).toEqual([]);
  });

  it("records metricQueriesTotal success/error with the definition's cost tier", async () => {
    manager.findOne.mockResolvedValueOnce(buildDefinition({ estimatedCostTier: MetricCostTier.MODERATE }));

    await service.query('tenant-1', 'adherence_trend');

    const values = (await metrics.getRegistry().getSingleMetric('analytics_metric_queries_total')?.get())?.values;
    expect(values).toEqual([expect.objectContaining({ labels: { cost_tier: 'moderate', result: 'success' } })]);
  });

  describe('queryForExport (Phase 6)', () => {
    it('reuses the same whitelist check query() uses - rejects a disallowed sourceView identically', async () => {
      manager.findOne.mockResolvedValueOnce(
        buildDefinition({ calculationDefinition: { sourceView: 'not_a_real_view', valueColumn: 'x' } }),
      );

      await expect(service.queryForExport('tenant-1', 'adherence_trend')).rejects.toThrow(MetricSourceNotAllowedError);
    });

    it('selects every allowed dimension column plus the value column - not just the value column query() selects', async () => {
      manager.findOne.mockResolvedValueOnce(buildDefinition());
      let capturedSql = '';
      replicaClient.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM analytics_mv.mv_adherence_trend_rollup')) {
          capturedSql = sql;
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.queryForExport('tenant-1', 'adherence_trend');

      expect(capturedSql).toContain('SELECT period_start, period_end, period_type, avg_adherence_pct');
      expect(result.columns).toEqual(['period_start', 'period_end', 'period_type', 'avg_adherence_pct']);
    });

    it('has no +1-row trend trick and no small default limit - every returned row is real, up to the large export cap', async () => {
      manager.findOne.mockResolvedValueOnce(buildDefinition());
      let capturedSql = '';
      replicaClient.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM analytics_mv.mv_adherence_trend_rollup')) {
          capturedSql = sql;
          return Promise.resolve({
            rows: [{ period_start: new Date(), period_end: new Date(), period_type: 'day', avg_adherence_pct: '10' }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.queryForExport('tenant-1', 'adherence_trend');

      expect(capturedSql).toContain('LIMIT 10000');
      expect(result.rows).toHaveLength(1); // no row dropped for a comparison trick
    });

    it('still applies period/dimension filters', async () => {
      manager.findOne.mockResolvedValueOnce(buildDefinition());
      let capturedSql = '';
      replicaClient.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM analytics_mv.mv_adherence_trend_rollup')) {
          capturedSql = sql;
        }
        return Promise.resolve({ rows: [] });
      });

      await service.queryForExport('tenant-1', 'adherence_trend', { periodType: 'month' });

      expect(capturedSql).toContain('period_type = $1::varchar');
    });
  });

  describe('executiveSummary', () => {
    it('always includes adherence_trend, scoped to periodType month', async () => {
      manager.findOne.mockResolvedValue(buildDefinition());
      let capturedSql = '';
      replicaClient.query.mockImplementation((sql: string) => {
        if (sql.includes('mv_adherence_trend_rollup')) {
          capturedSql = sql;
        }
        return Promise.resolve({ rows: [] });
      });

      await service.executiveSummary('tenant-1', undefined, 'current_month' as any);

      expect(capturedSql).toContain('period_type = $');
    });

    it('excludes org-scoped metrics when orgUnitId is not provided', async () => {
      manager.findOne.mockResolvedValue(buildDefinition());

      await service.executiveSummary('tenant-1', undefined, 'current_month' as any);

      // Only the adherence_trend lookup happens - forecast_accuracy_mape/attrition_terminations are never queried.
      expect(manager.findOne).toHaveBeenCalledTimes(1);
    });

    it('includes org-scoped metrics when orgUnitId is provided', async () => {
      manager.findOne.mockResolvedValue(buildDefinition());

      await service.executiveSummary('tenant-1', 'org-1', 'current_month' as any);

      expect(manager.findOne).toHaveBeenCalledTimes(3); // adherence_trend + forecast_accuracy_mape + attrition_terminations
    });

    it('never includes scheduled_hours/overtime_hours/approved_leave_days (cost_center grain has no org-unit/tenant-wide total)', async () => {
      manager.findOne.mockResolvedValue(buildDefinition());

      const results = await service.executiveSummary('tenant-1', 'org-1', 'current_month' as any);

      expect(
        results.every(
          (r) => r.metric !== 'scheduled_hours' && r.metric !== 'overtime_hours' && r.metric !== 'approved_leave_days',
        ),
      ).toBe(true);
    });
  });
});
