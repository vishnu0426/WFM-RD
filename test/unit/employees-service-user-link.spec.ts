import { EmployeesService } from '../../src/modules/employee/services/employees.service';
import { UserAlreadyLinkedError } from '../../src/modules/employee/errors/user-already-linked.error';
import { Employee } from '../../src/modules/employee/entities/employee.entity';

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function buildEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    tenantId: 't1',
    id: EMPLOYEE_ID,
    userId: null,
    orgUnitId: 'ou-1',
    employeeNumber: 'EMP-1',
    employmentType: 'full_time',
    contractHoursPerWeek: '40.00',
    hireDate: '2024-01-01',
    terminationDate: null,
    costCenter: null,
    managerEmployeeId: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Employee;
}

class FakeUniqueViolation extends Error {
  code = '23505';
}

describe('EmployeesService.update - userId link/unlink (ADR-0150/ADR-0157)', () => {
  function buildService(employee = buildEmployee()) {
    const employeesRepository = {
      findById: jest.fn().mockResolvedValue(employee),
      updateWithOutboxEvent: jest.fn().mockResolvedValue({ ...employee, userId: USER_ID }),
    };
    const orgUnitsService = { findById: jest.fn().mockResolvedValue({ id: 'ou-1' }) };
    const systemLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const service = new EmployeesService(employeesRepository as never, orgUnitsService as never, systemLimits as never);
    return { service, employeesRepository };
  }

  it('passes userId through to the repository when linking', async () => {
    const { service, employeesRepository } = buildService();

    await service.update(EMPLOYEE_ID, { userId: USER_ID });

    expect(employeesRepository.updateWithOutboxEvent).toHaveBeenCalledWith(
      EMPLOYEE_ID,
      expect.objectContaining({ userId: USER_ID }),
      expect.any(Function),
      undefined, // effectiveAt (GAP-07): omitted from the input, so "effective now"
    );
  });

  it('passes userId: null through when explicitly unlinking', async () => {
    const { service, employeesRepository } = buildService(buildEmployee({ userId: USER_ID }));

    await service.update(EMPLOYEE_ID, { userId: null });

    expect(employeesRepository.updateWithOutboxEvent).toHaveBeenCalledWith(
      EMPLOYEE_ID,
      expect.objectContaining({ userId: null }),
      expect.any(Function),
      undefined, // effectiveAt (GAP-07): omitted from the input, so "effective now"
    );
  });

  it('leaves userId untouched when the field is omitted entirely', async () => {
    const { service, employeesRepository } = buildService();

    await service.update(EMPLOYEE_ID, { costCenter: 'CC-1' });

    const [, partial] = employeesRepository.updateWithOutboxEvent.mock.calls[0];
    expect(partial).not.toHaveProperty('userId');
  });

  it('maps a unique-violation on the (tenant_id, user_id) index to UserAlreadyLinkedError', async () => {
    const { service, employeesRepository } = buildService();
    employeesRepository.updateWithOutboxEvent = jest.fn().mockRejectedValue(new FakeUniqueViolation());

    await expect(service.update(EMPLOYEE_ID, { userId: USER_ID })).rejects.toThrow(UserAlreadyLinkedError);
  });

  it('re-throws a non-unique-violation error unchanged', async () => {
    const { service, employeesRepository } = buildService();
    employeesRepository.updateWithOutboxEvent = jest.fn().mockRejectedValue(new Error('connection reset'));

    await expect(service.update(EMPLOYEE_ID, { userId: USER_ID })).rejects.toThrow('connection reset');
  });

  it('does not treat a unique-violation as UserAlreadyLinkedError when userId was not part of this update', async () => {
    const { service, employeesRepository } = buildService();
    employeesRepository.updateWithOutboxEvent = jest.fn().mockRejectedValue(new FakeUniqueViolation());

    await expect(service.update(EMPLOYEE_ID, { costCenter: 'CC-1' })).rejects.toThrow(FakeUniqueViolation);
  });
});
