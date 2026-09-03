import { MetricDefinitionService } from '../../../src/analytics/metric-definition.service';
import { MetricCategory, MetricCostTier } from '../../../src/analytics/entities/metric-definition.entity';
import { MetricNameAlreadyExistsError } from '../../../src/analytics/errors/metric-validation-failed.error';

describe('MetricDefinitionService', () => {
  let dataSource: { transaction: jest.Mock };
  let manager: { findOne: jest.Mock; find: jest.Mock; insert: jest.Mock; findOneByOrFail: jest.Mock; query: jest.Mock };
  let validation: { validateAndTier: jest.Mock };
  let service: MetricDefinitionService;

  const tenantId = 'tenant-1';
  const input = {
    name: 'night_shift_overtime',
    category: MetricCategory.COST,
    calculationDefinition: { sourceView: 'mv_cost_vs_budget', valueColumn: 'overtime_hours' },
  };

  beforeEach(() => {
    manager = {
      findOne: jest.fn(),
      find: jest.fn(),
      insert: jest.fn(),
      findOneByOrFail: jest.fn(),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = { transaction: jest.fn((work: (m: unknown) => unknown) => work(manager)) };
    validation = {
      validateAndTier: jest
        .fn()
        .mockResolvedValue({ validatedAt: new Date(), estimatedCostTier: MetricCostTier.CHEAP }),
    };
    service = new MetricDefinitionService(dataSource as any, validation as any);
  });

  it('validates before ever checking for a name collision or inserting', async () => {
    manager.findOne.mockResolvedValueOnce(null);
    manager.findOneByOrFail.mockResolvedValueOnce({ id: 'metric-1', ...input });

    await service.createMetricDefinition(tenantId, input);

    expect(validation.validateAndTier).toHaveBeenCalledWith(tenantId, input.name, input.calculationDefinition);
  });

  it('rejects with MetricNameAlreadyExistsError when the tenant already has a metric with this name, without inserting', async () => {
    manager.findOne.mockResolvedValueOnce({ id: 'existing' });

    await expect(service.createMetricDefinition(tenantId, input)).rejects.toThrow(MetricNameAlreadyExistsError);
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('does not even attempt the name-collision check or insert when validation itself throws', async () => {
    validation.validateAndTier.mockRejectedValueOnce(new Error('validation failed'));

    await expect(service.createMetricDefinition(tenantId, input)).rejects.toThrow('validation failed');
    expect(manager.findOne).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('inserts with the tenantId, and the validated_at/estimated_cost_tier the validation service returned', async () => {
    const validatedAt = new Date('2026-08-11T00:00:00Z');
    validation.validateAndTier.mockResolvedValueOnce({ validatedAt, estimatedCostTier: MetricCostTier.MODERATE });
    manager.findOne.mockResolvedValueOnce(null);
    manager.findOneByOrFail.mockResolvedValueOnce({ id: 'metric-1' });

    await service.createMetricDefinition(tenantId, input);

    expect(manager.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId,
        name: input.name,
        category: input.category,
        validatedAt,
        estimatedCostTier: MetricCostTier.MODERATE,
      }),
    );
  });

  describe('listVisibleMetrics', () => {
    it('returns platform defaults ahead of tenant-owned rows, both fetched, neither silently dropped', async () => {
      const platformDefaults = [{ id: 'p1', tenantId: null, name: 'adherence_trend' }];
      const tenantOwned = [{ id: 't1', tenantId, name: 'night_shift_overtime' }];
      manager.find.mockResolvedValueOnce(tenantOwned).mockResolvedValueOnce(platformDefaults);

      const result = await service.listVisibleMetrics(tenantId);

      expect(result).toEqual([...platformDefaults, ...tenantOwned]);
    });
  });
});
