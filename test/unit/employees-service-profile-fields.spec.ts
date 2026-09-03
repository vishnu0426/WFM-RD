import { EmployeesService } from '../../src/modules/employee/services/employees.service';
import { EmployeeStatus } from '../../src/modules/employee/entities/employee-status.enum';
import { Employee } from '../../src/modules/employee/entities/employee.entity';

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';

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
    status: EmployeeStatus.ACTIVE,
    middleInitial: null,
    suffix: null,
    birthDate: null,
    email: null,
    desktopMessagingUsername: null,
    homePhone: null,
    workPhone: null,
    cellPhone: null,
    homeAddress: null,
    isSupervisor: false,
    isTeamLead: false,
    teamLeadEmployeeId: null,
    jobTitle: null,
    taxId: null,
    wageAmount: null,
    rank: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Employee;
}

function buildService(employee = buildEmployee()) {
  const employeesRepository = {
    findById: jest.fn().mockResolvedValue(employee),
    createWithOutboxEvent: jest.fn().mockResolvedValue(employee),
    updateWithOutboxEvent: jest.fn().mockResolvedValue(employee),
    count: jest.fn().mockResolvedValue(0),
  };
  const orgUnitsService = { findById: jest.fn().mockResolvedValue({ id: 'ou-1' }) };
  const systemLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
  const service = new EmployeesService(employeesRepository as never, orgUnitsService as never, systemLimits as never);
  return { service, employeesRepository };
}

describe('EmployeesService — Profile fields', () => {
  describe('create', () => {
    it('passes every new field through to the repository, defaulting unset ones', async () => {
      const { service, employeesRepository } = buildService();

      await service.create({
        orgUnitId: 'ou-1',
        employeeNumber: 'EMP-2',
        employmentType: 'full_time' as never,
        contractHoursPerWeek: 40,
        hireDate: '2026-01-01',
        middleInitial: 'Q',
        suffix: 'Jr.',
        birthDate: '1990-05-01',
        email: 'person@example.com',
        wageAmount: 55000.5,
        rank: 3,
        isSupervisor: true,
      } as never);

      const [input] = employeesRepository.createWithOutboxEvent.mock.calls[0];
      expect(input).toMatchObject({
        middleInitial: 'Q',
        suffix: 'Jr.',
        birthDate: '1990-05-01',
        email: 'person@example.com',
        wageAmount: '55000.50',
        rank: 3,
        isSupervisor: true,
        isTeamLead: false, // defaulted, not supplied
        taxId: null,
      });
    });
  });

  describe('update', () => {
    it('leaves every new field untouched when omitted', async () => {
      const { service, employeesRepository } = buildService();

      await service.update(EMPLOYEE_ID, { costCenter: 'CC-1' } as never);

      const [, partial] = employeesRepository.updateWithOutboxEvent.mock.calls[0];
      for (const field of ['middleInitial', 'birthDate', 'email', 'taxId', 'wageAmount', 'rank', 'isSupervisor']) {
        expect(partial).not.toHaveProperty(field);
      }
    });

    it('writes only the fields actually supplied, formatting wageAmount to 2 decimals', async () => {
      const { service, employeesRepository } = buildService();

      await service.update(EMPLOYEE_ID, { jobTitle: 'Team Lead', wageAmount: 61000 } as never);

      const [, partial] = employeesRepository.updateWithOutboxEvent.mock.calls[0];
      expect(partial).toMatchObject({ jobTitle: 'Team Lead', wageAmount: '61000.00' });
      expect(partial).not.toHaveProperty('email');
    });

    it('accepts null to explicitly clear a nullable field (e.g. unsetting Tax ID)', async () => {
      const { service, employeesRepository } = buildService(buildEmployee({ taxId: '123-45-6789' }));

      await service.update(EMPLOYEE_ID, { taxId: null } as never);

      const [, partial] = employeesRepository.updateWithOutboxEvent.mock.calls[0];
      expect(partial).toMatchObject({ taxId: null });
    });
  });

  describe('revealTaxId', () => {
    it('returns the real, unmasked value', async () => {
      const { service } = buildService(buildEmployee({ taxId: '123-45-6789' }));

      await expect(service.revealTaxId(EMPLOYEE_ID)).resolves.toBe('123-45-6789');
    });

    it('returns null when no Tax ID is on file', async () => {
      const { service } = buildService(buildEmployee({ taxId: null }));

      await expect(service.revealTaxId(EMPLOYEE_ID)).resolves.toBeNull();
    });
  });
});
