import { DataSource, EntityManager } from 'typeorm';
import { ListAttendanceExceptionsService } from '../../../src/attendance/list-attendance-exceptions.service';
import { AttendanceExceptionType } from '../../../src/attendance/entities/attendance-record.entity';
import { EmployeeGrpcClientService, SchedulableEmployee } from '../../../src/grpc/employee-grpc-client.service';

describe('ListAttendanceExceptionsService', () => {
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
  let service: ListAttendanceExceptionsService;

  const tenantId = 'tenant-1';
  const orgUnitId = 'org-unit-1';
  const dateFrom = new Date('2026-08-01T00:00:00.000Z');
  const dateTo = new Date('2026-08-15T00:00:00.000Z');

  const roster: SchedulableEmployee[] = [
    {
      employeeId: 'emp-1',
      employeeNumber: 'E1',
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
    service = new ListAttendanceExceptionsService(
      dataSource as DataSource,
      employeeGrpcClient as unknown as EmployeeGrpcClientService,
    );
  });

  it('resolves the roster, filters to non-null exceptionType within the date range, ordered/paginated', async () => {
    queryBuilder.getMany.mockResolvedValue([]);

    await service.listForOrgUnit(tenantId, orgUnitId, dateFrom, dateTo, undefined, 50, 0);

    expect(employeeGrpcClient.getSchedulableRoster).toHaveBeenCalledWith(tenantId, orgUnitId);
    expect(queryBuilder.where).toHaveBeenCalledWith('record.tenantId = :tenantId', { tenantId });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('record.employeeId IN (:...employeeIds)', {
      employeeIds: ['emp-1'],
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('record.exceptionType IS NOT NULL');
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('record.clockInAt >= :dateFrom', { dateFrom });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('record.clockInAt <= :dateTo', { dateTo });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('record.clockInAt', 'DESC');
    expect(queryBuilder.take).toHaveBeenCalledWith(50);
    expect(queryBuilder.skip).toHaveBeenCalledWith(0);
  });

  it('adds an exceptionType filter only when one is provided', async () => {
    queryBuilder.getMany.mockResolvedValue([]);

    await service.listForOrgUnit(tenantId, orgUnitId, dateFrom, dateTo, AttendanceExceptionType.LATE, 50, 0);

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('record.exceptionType = :exceptionType', {
      exceptionType: AttendanceExceptionType.LATE,
    });
  });

  it('returns an empty array without querying the database when the roster is empty', async () => {
    employeeGrpcClient.getSchedulableRoster.mockResolvedValue([]);

    const result = await service.listForOrgUnit(tenantId, orgUnitId, dateFrom, dateTo, undefined, 50, 0);

    expect(result).toEqual([]);
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
  });
});
