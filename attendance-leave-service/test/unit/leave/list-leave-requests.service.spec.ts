import { DataSource, EntityManager } from 'typeorm';
import { ListLeaveRequestsService } from '../../../src/leave/list-leave-requests.service';
import { LeaveRequest, LeaveRequestStatus } from '../../../src/leave/entities/leave-request.entity';
import { EmployeeGrpcClientService, SchedulableEmployee } from '../../../src/grpc/employee-grpc-client.service';

describe('ListLeaveRequestsService', () => {
  let queryBuilder: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    take: jest.Mock;
    skip: jest.Mock;
    getMany: jest.Mock;
  };
  let manager: jest.Mocked<Pick<EntityManager, 'createQueryBuilder' | 'query'>>;
  let dataSource: Pick<DataSource, 'transaction'>;
  let employeeGrpcClient: jest.Mocked<Pick<EmployeeGrpcClientService, 'getSchedulableRoster'>>;
  let service: ListLeaveRequestsService;

  const tenantId = 'tenant-1';
  const orgUnitId = 'org-unit-1';

  const roster: SchedulableEmployee[] = [
    {
      employeeId: 'emp-1',
      employeeNumber: 'E1',
      orgUnitId,
      contractHoursPerWeek: 40,
      employmentType: 'full_time',
      hireDate: '2020-01-01',
    },
    {
      employeeId: 'emp-2',
      employeeNumber: 'E2',
      orgUnitId,
      contractHoursPerWeek: 40,
      employmentType: 'full_time',
      hireDate: '2020-01-01',
    },
  ];

  beforeEach(() => {
    queryBuilder = {
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      take: jest.fn(),
      skip: jest.fn(),
      getMany: jest.fn(),
    };
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);
    queryBuilder.orderBy.mockReturnValue(queryBuilder);
    queryBuilder.take.mockReturnValue(queryBuilder);
    queryBuilder.skip.mockReturnValue(queryBuilder);

    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    employeeGrpcClient = { getSchedulableRoster: jest.fn().mockResolvedValue(roster) };
    service = new ListLeaveRequestsService(
      dataSource as DataSource,
      employeeGrpcClient as unknown as EmployeeGrpcClientService,
    );
  });

  it('resolves the org-unit roster, then filters by employeeId/status, ordered by requestedAt descending, paginated', async () => {
    queryBuilder.getMany.mockResolvedValue([]);

    await service.listForOrgUnit(tenantId, orgUnitId, LeaveRequestStatus.PENDING, 50, 0);

    expect(employeeGrpcClient.getSchedulableRoster).toHaveBeenCalledWith(tenantId, orgUnitId);
    expect(queryBuilder.where).toHaveBeenCalledWith('request.tenantId = :tenantId', { tenantId });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('request.employeeId IN (:...employeeIds)', {
      employeeIds: ['emp-1', 'emp-2'],
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('request.status = :status', {
      status: LeaveRequestStatus.PENDING,
    });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('request.requestedAt', 'DESC');
    expect(queryBuilder.take).toHaveBeenCalledWith(50);
    expect(queryBuilder.skip).toHaveBeenCalledWith(0);
  });

  it('returns an empty array without querying the database when the roster is empty', async () => {
    employeeGrpcClient.getSchedulableRoster.mockResolvedValue([]);

    const result = await service.listForOrgUnit(tenantId, orgUnitId, LeaveRequestStatus.PENDING, 50, 0);

    expect(result).toEqual([]);
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns the rows the query produces', async () => {
    const rows: LeaveRequest[] = [
      {
        id: 'request-1',
        tenantId,
        employeeId: 'emp-1',
        leaveTypeId: 'type-1',
        dateRangeStart: '2026-06-01',
        dateRangeEnd: '2026-06-03',
        status: LeaveRequestStatus.PENDING,
        approvalChainId: null,
        requestedAt: new Date(),
        decidedAt: null,
        decidedBy: null,
        conflictFlags: {},
        isBackdated: false,
        backdatedReason: null,
        backdatedApprovedBy: null,
        decisionReason: null,
      },
    ];
    queryBuilder.getMany.mockResolvedValue(rows);

    const result = await service.listForOrgUnit(tenantId, orgUnitId, LeaveRequestStatus.PENDING, 50, 0);

    expect(result).toEqual(rows);
  });
});
