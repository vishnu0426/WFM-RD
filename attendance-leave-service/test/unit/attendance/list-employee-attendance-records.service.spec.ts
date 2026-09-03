import { DataSource, EntityManager } from 'typeorm';
import { ListEmployeeAttendanceRecordsService } from '../../../src/attendance/list-employee-attendance-records.service';
import { AttendanceRecord, AttendanceSource } from '../../../src/attendance/entities/attendance-record.entity';

describe('ListEmployeeAttendanceRecordsService', () => {
  let queryBuilder: { where: jest.Mock; andWhere: jest.Mock; orderBy: jest.Mock; getMany: jest.Mock };
  let manager: jest.Mocked<Pick<EntityManager, 'createQueryBuilder' | 'query'>>;
  let dataSource: Pick<DataSource, 'transaction'>;
  let service: ListEmployeeAttendanceRecordsService;

  const tenantId = 'tenant-1';
  const employeeId = 'emp-1';
  const from = new Date('2026-08-01T00:00:00.000Z');
  const to = new Date('2026-08-15T00:00:00.000Z');

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
    service = new ListEmployeeAttendanceRecordsService(dataSource as DataSource);
  });

  it('filters to the tenant, employee, and clockInAt date range, ordered by clockInAt descending', async () => {
    const rows: AttendanceRecord[] = [
      {
        id: 'r1',
        tenantId,
        employeeId,
        clockInAt: new Date('2026-08-10T09:00:00.000Z'),
        clockOutAt: new Date('2026-08-10T17:00:00.000Z'),
        source: AttendanceSource.MOBILE_APP,
        scheduledShiftId: null,
        exceptionType: null,
        exceptionMinutes: null,
        geofenceVerified: null,
      },
    ];
    queryBuilder.getMany.mockResolvedValue(rows);

    const result = await service.listForEmployee(tenantId, employeeId, from, to);

    expect(queryBuilder.where).toHaveBeenCalledWith('record.tenantId = :tenantId', { tenantId });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('record.employeeId = :employeeId', { employeeId });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('record.clockInAt >= :from', { from });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('record.clockInAt < :to', { to });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('record.clockInAt', 'DESC');
    expect(result).toEqual(rows);
  });

  it('returns an empty array, not an error, when no records exist in the range', async () => {
    queryBuilder.getMany.mockResolvedValue([]);

    const result = await service.listForEmployee(tenantId, employeeId, from, to);

    expect(result).toEqual([]);
  });
});
