import { DataSource, EntityManager } from 'typeorm';
import { ListEmployeeLeaveBalancesService } from '../../../src/leave/list-employee-leave-balances.service';
import { LeaveBalance } from '../../../src/leave/entities/leave-balance.entity';

describe('ListEmployeeLeaveBalancesService', () => {
  let queryBuilder: { where: jest.Mock; andWhere: jest.Mock; getMany: jest.Mock };
  let manager: jest.Mocked<Pick<EntityManager, 'createQueryBuilder' | 'query'>>;
  let dataSource: Pick<DataSource, 'transaction'>;
  let service: ListEmployeeLeaveBalancesService;

  const tenantId = 'tenant-1';
  const employeeId = 'emp-1';

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
    service = new ListEmployeeLeaveBalancesService(dataSource as DataSource);
  });

  it('filters to the tenant, employee, and periods covering today', async () => {
    const rows: LeaveBalance[] = [
      {
        employeeId,
        leaveTypeId: 'lt-1',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        tenantId,
        accruedDays: '20.00',
        usedDays: '5.00',
        pendingDays: '2.00',
        carryoverDaysIn: '0.00',
        carryoverExpiryDate: null,
        carryoverApplied: false,
        lastAccruedAt: null,
      },
    ];
    queryBuilder.getMany.mockResolvedValue(rows);

    const result = await service.listCurrentForEmployee(tenantId, employeeId);

    expect(queryBuilder.where).toHaveBeenCalledWith('balance.tenantId = :tenantId', { tenantId });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('balance.employeeId = :employeeId', { employeeId });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'balance.periodStart <= :today',
      expect.objectContaining({ today: expect.any(String) }),
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'balance.periodEnd >= :today',
      expect.objectContaining({ today: expect.any(String) }),
    );
    expect(result).toEqual(rows);
  });

  it('returns an empty array, not an error, when the employee has no current-period balance', async () => {
    queryBuilder.getMany.mockResolvedValue([]);

    const result = await service.listCurrentForEmployee(tenantId, employeeId);

    expect(result).toEqual([]);
  });
});
