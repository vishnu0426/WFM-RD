import { DataSource, EntityManager } from 'typeorm';
import { AcknowledgeAbsencePatternService } from '../../../../src/leave/absence-pattern/acknowledge-absence-pattern.service';
import { AbsencePattern, AbsencePatternType } from '../../../../src/leave/entities/absence-pattern.entity';
import { AcknowledgeAbsencePatternDto } from '../../../../src/leave/absence-pattern/dto/acknowledge-absence-pattern.dto';
import { AbsencePatternNotFoundError } from '../../../../src/common/errors/absence-pattern-not-found.error';
import { AbsencePatternAlreadyAcknowledgedError } from '../../../../src/common/errors/absence-pattern-already-acknowledged.error';
import { MetricsService } from '../../../../src/common/metrics/metrics.service';

function pattern(overrides: Partial<AbsencePattern> = {}): AbsencePattern {
  return {
    id: 'pattern-1',
    tenantId: 'tenant-1',
    employeeId: 'emp-1',
    patternType: AbsencePatternType.FREQUENCY_THRESHOLD,
    confidenceScore: '0.75',
    detectedAt: new Date(),
    acknowledgedBy: null,
    outcome: null,
    ...overrides,
  };
}

describe('AcknowledgeAbsencePatternService', () => {
  let queryBuilder: { setLock: jest.Mock; where: jest.Mock; andWhere: jest.Mock; getOne: jest.Mock };
  let manager: jest.Mocked<Pick<EntityManager, 'createQueryBuilder' | 'update' | 'findOneByOrFail' | 'query'>>;
  let dataSource: Pick<DataSource, 'transaction'>;
  let metrics: MetricsService;
  let service: AcknowledgeAbsencePatternService;

  const tenantId = 'tenant-1';
  const dto: AcknowledgeAbsencePatternDto = Object.assign(new AcknowledgeAbsencePatternDto(), {
    acknowledgedBy: 'manager-1',
    outcome: 'acknowledged',
  });

  beforeEach(() => {
    queryBuilder = { setLock: jest.fn(), where: jest.fn(), andWhere: jest.fn(), getOne: jest.fn() };
    queryBuilder.setLock.mockReturnValue(queryBuilder);
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);

    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      update: jest.fn().mockResolvedValue({}),
      findOneByOrFail: jest.fn(),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    metrics = new MetricsService();
    service = new AcknowledgeAbsencePatternService(dataSource as DataSource, metrics);
  });

  it('acknowledges an unacknowledged pattern', async () => {
    queryBuilder.getOne.mockResolvedValue(pattern());
    manager.findOneByOrFail.mockResolvedValue(pattern({ acknowledgedBy: 'manager-1' }));

    const result = await service.acknowledge(tenantId, 'pattern-1', dto);

    expect(manager.update).toHaveBeenCalledWith(
      AbsencePattern,
      { id: 'pattern-1' },
      { acknowledgedBy: 'manager-1', outcome: 'acknowledged' },
    );
    expect(result.acknowledgedBy).toBe('manager-1');
  });

  it('persists a "dismissed" outcome distinctly from "acknowledged"', async () => {
    const dismissDto: AcknowledgeAbsencePatternDto = Object.assign(new AcknowledgeAbsencePatternDto(), {
      acknowledgedBy: 'manager-1',
      outcome: 'dismissed',
    });
    queryBuilder.getOne.mockResolvedValue(pattern());
    manager.findOneByOrFail.mockResolvedValue(pattern({ acknowledgedBy: 'manager-1', outcome: 'dismissed' }));

    await service.acknowledge(tenantId, 'pattern-1', dismissDto);

    expect(manager.update).toHaveBeenCalledWith(
      AbsencePattern,
      { id: 'pattern-1' },
      { acknowledgedBy: 'manager-1', outcome: 'dismissed' },
    );
  });

  it('rejects with AbsencePatternNotFoundError when the pattern does not exist, without updating', async () => {
    queryBuilder.getOne.mockResolvedValue(null);

    await expect(service.acknowledge(tenantId, 'missing', dto)).rejects.toThrow(AbsencePatternNotFoundError);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('rejects with AbsencePatternAlreadyAcknowledgedError when already acknowledged, without updating', async () => {
    queryBuilder.getOne.mockResolvedValue(pattern({ acknowledgedBy: 'someone-else' }));

    await expect(service.acknowledge(tenantId, 'pattern-1', dto)).rejects.toThrow(
      AbsencePatternAlreadyAcknowledgedError,
    );
    expect(manager.update).not.toHaveBeenCalled();
  });
});
