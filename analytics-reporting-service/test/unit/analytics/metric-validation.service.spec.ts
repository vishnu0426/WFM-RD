import { MetricValidationService } from '../../../src/analytics/metric-validation.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { MetricCostTier } from '../../../src/analytics/entities/metric-definition.entity';
import { MetricSourceNotAllowedError } from '../../../src/analytics/errors/metric-not-found.error';
import { MetricValidationFailedError } from '../../../src/analytics/errors/metric-validation-failed.error';

describe('MetricValidationService', () => {
  let replicaPool: { connect: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let metrics: MetricsService;
  let service: MetricValidationService;

  beforeEach(() => {
    client = { query: jest.fn(), release: jest.fn() };
    replicaPool = { connect: jest.fn().mockResolvedValue(client) };
    metrics = new MetricsService();
    service = new MetricValidationService(replicaPool as any, metrics);

    client.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SELECT set_config')) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('rejects a sourceView not in SOURCE_VIEW_REGISTRY, without ever running a dry-run query', async () => {
    await expect(
      service.validateAndTier('tenant-1', 'bad', { sourceView: 'not_a_real_view', valueColumn: 'x' }),
    ).rejects.toThrow(MetricSourceNotAllowedError);
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('SELECT x'));
  });

  it("rejects a valueColumn not on that view's whitelist", async () => {
    await expect(
      service.validateAndTier('tenant-1', 'bad', {
        sourceView: 'mv_cost_vs_budget',
        valueColumn: 'sql_injection; DROP TABLE x',
      }),
    ).rejects.toThrow(MetricSourceNotAllowedError);
  });

  it("rejects a dimension not on that view's allowedDimensions", async () => {
    await expect(
      service.validateAndTier('tenant-1', 'bad', {
        sourceView: 'mv_cost_vs_budget',
        valueColumn: 'overtime_hours',
        dimensions: ['org_unit_id'], // mv_cost_vs_budget only allows cost_center
      }),
    ).rejects.toThrow(MetricSourceNotAllowedError);
  });

  it('runs a real bounded dry-run against the replica pool for a whitelist-legal definition', async () => {
    await service.validateAndTier('tenant-1', 'ok', { sourceView: 'mv_cost_vs_budget', valueColumn: 'overtime_hours' });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT overtime_hours FROM analytics_mv.mv_cost_vs_budget'),
      [],
    );
  });

  it('classifies cost tier as cheap for a fast dry-run', async () => {
    const result = await service.validateAndTier('tenant-1', 'ok', {
      sourceView: 'mv_cost_vs_budget',
      valueColumn: 'overtime_hours',
    });

    expect(result.estimatedCostTier).toBe(MetricCostTier.CHEAP);
    expect(result.validatedAt).toBeInstanceOf(Date);
  });

  it('rejects with MetricValidationFailedError when the dry-run query itself throws, even though it passed the whitelist check', async () => {
    client.query.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT overtime_hours')) {
        return Promise.reject(new Error('relation does not exist'));
      }
      return Promise.resolve(undefined);
    });

    await expect(
      service.validateAndTier('tenant-1', 'ok', { sourceView: 'mv_cost_vs_budget', valueColumn: 'overtime_hours' }),
    ).rejects.toThrow(MetricValidationFailedError);
  });

  it('records analytics_metric_definition_validations_total with the measured cost tier on success', async () => {
    await service.validateAndTier('tenant-1', 'ok', { sourceView: 'mv_cost_vs_budget', valueColumn: 'overtime_hours' });

    const values = (await metrics.getRegistry().getSingleMetric('analytics_metric_definition_validations_total')?.get())
      ?.values;
    expect(values).toEqual([expect.objectContaining({ labels: { result: 'validated', cost_tier: 'cheap' } })]);
  });

  it('records a rejected outcome (no cost_tier) when the whitelist check fails', async () => {
    await expect(
      service.validateAndTier('tenant-1', 'bad', { sourceView: 'not_a_real_view', valueColumn: 'x' }),
    ).rejects.toThrow();

    const values = (await metrics.getRegistry().getSingleMetric('analytics_metric_definition_validations_total')?.get())
      ?.values;
    expect(values).toEqual([expect.objectContaining({ labels: { result: 'rejected', cost_tier: '' } })]);
  });
});
