import { DataSource, EntityManager } from 'typeorm';
import { AiGovernancePolicyService } from '../../../src/ai/ai-governance-policy.service';
import { AiGovernancePolicy, AiAutonomyLevel } from '../../../src/ai/entities/ai-governance-policy.entity';
import { AiGovernancePolicyHistory } from '../../../src/ai/entities/ai-governance-policy-history.entity';

function buildDataSource(existing: AiGovernancePolicy | null, history: AiGovernancePolicyHistory[] = []) {
  const saved: AiGovernancePolicy[] = [];
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(history),
  };
  const manager = {
    query: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn().mockResolvedValue(existing),
    create: jest.fn((_entityClass: unknown, plain: Partial<AiGovernancePolicy>) => plain as AiGovernancePolicy),
    save: jest.fn((_entityClass: unknown, entity: AiGovernancePolicy) => {
      saved.push(entity);
      return Promise.resolve(entity);
    }),
    getRepository: jest.fn().mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) }),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((work: (manager: EntityManager) => Promise<unknown>) => work(manager)),
  } as unknown as DataSource;
  return { dataSource, saved, queryBuilder };
}

describe('AiGovernancePolicyService.update', () => {
  it('creates a new row when none exists for this (tenant, action_type)', async () => {
    const { dataSource, saved } = buildDataSource(null);
    const service = new AiGovernancePolicyService(dataSource);

    const result = await service.update(
      't1',
      'reallocation',
      AiAutonomyLevel.AUTO_EXECUTE_LOW_RISK,
      { maxAffectedEmployees: 5 },
      null,
    );

    expect(result.tenantId).toBe('t1');
    expect(result.actionType).toBe('reallocation');
    expect(result.autonomyLevel).toBe(AiAutonomyLevel.AUTO_EXECUTE_LOW_RISK);
    expect(result.updatedBy).toBeNull();
    expect(saved).toHaveLength(1);
  });

  it('upserts (updates in place) when a row already exists - never a duplicate', async () => {
    const existing = Object.assign(new AiGovernancePolicy(), {
      id: 'p1',
      tenantId: 't1',
      actionType: 'reallocation',
      autonomyLevel: AiAutonomyLevel.SUGGEST_ONLY,
      riskThresholdConfig: {},
      updatedAt: new Date('2020-01-01'),
      updatedBy: null,
    });
    const { dataSource, saved } = buildDataSource(existing);
    const service = new AiGovernancePolicyService(dataSource);

    const result = await service.update('t1', 'reallocation', AiAutonomyLevel.APPROVE_REQUIRED, {}, 'admin-1');

    expect(result.id).toBe('p1');
    expect(result.autonomyLevel).toBe(AiAutonomyLevel.APPROVE_REQUIRED);
    expect(result.updatedBy).toBe('admin-1');
    expect(saved).toHaveLength(1);
  });
});

describe('AiGovernancePolicyService.getHistory', () => {
  it('returns the history repository rows, newest-first, scoped to (tenantId, actionType)', async () => {
    const historyRow = Object.assign(new AiGovernancePolicyHistory(), {
      id: 'h1',
      tenantId: 't1',
      governancePolicyId: 'p1',
      validFrom: new Date('2020-01-01'),
      validTo: null,
      actionType: 'reallocation',
      autonomyLevel: AiAutonomyLevel.APPROVE_REQUIRED,
      riskThresholdConfig: {},
      updatedBy: 'admin-1',
    });
    const { dataSource, queryBuilder } = buildDataSource(null, [historyRow]);
    const service = new AiGovernancePolicyService(dataSource);

    const result = await service.getHistory('t1', 'reallocation');

    expect(result).toEqual([historyRow]);
    expect(queryBuilder.where).toHaveBeenCalledWith('h.tenant_id = :tenantId', { tenantId: 't1' });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('h.action_type = :actionType', { actionType: 'reallocation' });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('h.valid_from', 'DESC');
  });

  it('returns an empty array when the tenant has never configured this action_type', async () => {
    const { dataSource } = buildDataSource(null, []);
    const service = new AiGovernancePolicyService(dataSource);

    const result = await service.getHistory('t1', 'never-configured');

    expect(result).toEqual([]);
  });
});
