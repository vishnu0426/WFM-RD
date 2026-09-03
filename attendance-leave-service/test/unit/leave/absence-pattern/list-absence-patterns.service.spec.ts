import { DataSource, EntityManager } from 'typeorm';
import { ListAbsencePatternsService } from '../../../../src/leave/absence-pattern/list-absence-patterns.service';
import { AbsencePattern, AbsencePatternType } from '../../../../src/leave/entities/absence-pattern.entity';

describe('ListAbsencePatternsService', () => {
  let queryBuilder: { where: jest.Mock; andWhere: jest.Mock; orderBy: jest.Mock; getMany: jest.Mock };
  let manager: jest.Mocked<Pick<EntityManager, 'createQueryBuilder' | 'query'>>;
  let dataSource: Pick<DataSource, 'transaction'>;
  let service: ListAbsencePatternsService;

  const tenantId = 'tenant-1';

  beforeEach(() => {
    queryBuilder = { where: jest.fn(), andWhere: jest.fn(), orderBy: jest.fn(), getMany: jest.fn() };
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);
    queryBuilder.orderBy.mockReturnValue(queryBuilder);

    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    service = new ListAbsencePatternsService(dataSource as DataSource);
  });

  it('filters to unacknowledged patterns for the tenant, ordered by detectedAt descending', async () => {
    const rows: AbsencePattern[] = [
      {
        id: 'p1',
        tenantId,
        employeeId: 'emp-1',
        patternType: AbsencePatternType.RECURRING_DAY_OF_WEEK,
        confidenceScore: '0.6',
        detectedAt: new Date(),
        acknowledgedBy: null,
        outcome: null,
      },
    ];
    queryBuilder.getMany.mockResolvedValue(rows);

    const result = await service.listUnacknowledged(tenantId);

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('pattern.acknowledgedBy IS NULL');
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('pattern.detectedAt', 'DESC');
    expect(result).toEqual(rows);
  });
});
