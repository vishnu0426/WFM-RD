import { DataSource, EntityManager } from 'typeorm';
import {
  AiGovernancePolicyResolverService,
  DEFAULT_ACTION_TYPE,
  PLATFORM_DEFAULT_AUTONOMY_LEVEL,
} from '../../../src/ai/ai-governance-policy-resolver.service';
import { AiAutonomyLevel } from '../../../src/ai/entities/ai-governance-policy.entity';

function buildDataSource(
  rowsByActionType: Record<string, { autonomyLevel: AiAutonomyLevel; riskThresholdConfig: object } | undefined>,
) {
  const manager = {
    query: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn((_entityClass: unknown, options: { where: { actionType: string } }) =>
      Promise.resolve(rowsByActionType[options.where.actionType] ?? null),
    ),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((work: (manager: EntityManager) => Promise<unknown>) => work(manager)),
  } as unknown as DataSource;
  return dataSource;
}

describe('AiGovernancePolicyResolverService.resolve', () => {
  it('returns the exact action_type row when one exists', async () => {
    const dataSource = buildDataSource({
      reallocation: {
        autonomyLevel: AiAutonomyLevel.AUTO_EXECUTE_LOW_RISK,
        riskThresholdConfig: { maxAffectedEmployees: 5 },
      },
    });
    const service = new AiGovernancePolicyResolverService(dataSource);

    const result = await service.resolve('t1', 'reallocation');

    expect(result).toEqual({
      autonomyLevel: AiAutonomyLevel.AUTO_EXECUTE_LOW_RISK,
      riskThresholdConfig: { maxAffectedEmployees: 5 },
    });
  });

  it("falls back to the tenant's own 'default' row when no exact match exists", async () => {
    const dataSource = buildDataSource({
      [DEFAULT_ACTION_TYPE]: { autonomyLevel: AiAutonomyLevel.APPROVE_REQUIRED, riskThresholdConfig: {} },
    });
    const service = new AiGovernancePolicyResolverService(dataSource);

    const result = await service.resolve('t1', 'reallocation');

    expect(result.autonomyLevel).toBe(AiAutonomyLevel.APPROVE_REQUIRED);
  });

  it('falls back to the hardcoded platform default (suggest_only) when nothing is configured at all', async () => {
    const dataSource = buildDataSource({});
    const service = new AiGovernancePolicyResolverService(dataSource);

    const result = await service.resolve('t1', 'reallocation');

    expect(result.autonomyLevel).toBe(PLATFORM_DEFAULT_AUTONOMY_LEVEL);
    expect(result.autonomyLevel).toBe(AiAutonomyLevel.SUGGEST_ONLY);
    expect(result.riskThresholdConfig).toEqual({});
  });

  it("never re-checks the 'default' row when the action_type IS already 'default'", async () => {
    const dataSource = buildDataSource({});
    const service = new AiGovernancePolicyResolverService(dataSource);

    await service.resolve('t1', DEFAULT_ACTION_TYPE);

    // Exactly one lookup (the exact match on 'default' itself), not a second redundant one.
    expect((dataSource.transaction as jest.Mock).mock.calls.length).toBe(1);
  });
});
