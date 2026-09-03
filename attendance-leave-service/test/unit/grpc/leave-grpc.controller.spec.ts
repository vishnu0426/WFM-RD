import { DataSource, EntityManager } from 'typeorm';
import { LeaveGrpcController } from '../../../src/grpc/controllers/leave-grpc.controller';
import { LeaveRequest } from '../../../src/leave/entities/leave-request.entity';
import { TenantContextService } from '../../../src/common/tenant/tenant-context.service';

describe('LeaveGrpcController', () => {
  let queryBuilder: { where: jest.Mock; andWhere: jest.Mock; getMany: jest.Mock };
  let manager: jest.Mocked<Pick<EntityManager, 'createQueryBuilder' | 'query'>>;
  let dataSource: Pick<DataSource, 'transaction'>;
  let tenantContext: TenantContextService;
  let controller: LeaveGrpcController;

  const tenantId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    queryBuilder = { where: jest.fn(), andWhere: jest.fn(), getMany: jest.fn() };
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);

    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    tenantContext = new TenantContextService();
    controller = new LeaveGrpcController(tenantContext, dataSource as DataSource);
  });

  it('maps approved LeaveRequest rows to UnavailabilityRecord entries', async () => {
    queryBuilder.getMany.mockResolvedValue([
      {
        employeeId: 'emp-1',
        dateRangeStart: '2026-06-01',
        dateRangeEnd: '2026-06-03',
        leaveTypeId: 'type-1',
      } as LeaveRequest,
    ]);

    const result = await controller.getUnavailability({
      tenantId,
      employeeIds: ['emp-1'],
      dateRangeStart: '2026-06-01',
      dateRangeEnd: '2026-06-30',
    });

    expect(result.records).toEqual([
      { employeeId: 'emp-1', startDate: '2026-06-01', endDate: '2026-06-03', leaveTypeId: 'type-1' },
    ]);
  });

  it('only ever filters on status = approved (§2.2 rule 2 - never pending/rejected)', async () => {
    queryBuilder.getMany.mockResolvedValue([]);

    await controller.getUnavailability({
      tenantId,
      employeeIds: ['emp-1'],
      dateRangeStart: '2026-06-01',
      dateRangeEnd: '2026-06-30',
    });

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('request.status = :status', { status: 'approved' });
  });

  it('returns no records for an empty employeeIds list, without an invalid empty IN clause', async () => {
    queryBuilder.getMany.mockResolvedValue([]);

    const result = await controller.getUnavailability({
      tenantId,
      employeeIds: [],
      dateRangeStart: '2026-06-01',
      dateRangeEnd: '2026-06-30',
    });

    expect(result.records).toEqual([]);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('request.employeeId IN (:...employeeIds)', {
      employeeIds: [null],
    });
  });
});
