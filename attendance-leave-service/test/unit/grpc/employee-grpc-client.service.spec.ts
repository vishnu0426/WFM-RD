import { of, throwError } from 'rxjs';
import { ClientGrpc } from '@nestjs/microservices';
import {
  EmployeeGrpcClientService,
  EmployeeGrpcClientUnavailableError,
} from '../../../src/grpc/employee-grpc-client.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_UNIT_ID = '44444444-4444-4444-8444-444444444444';

describe('EmployeeGrpcClientService.getEmployeeIdForUser (ADR-0150/ADR-0157)', () => {
  let getEmployeeIdForUser: jest.Mock;
  let grpcClient: jest.Mocked<Pick<ClientGrpc, 'getService'>>;
  let service: EmployeeGrpcClientService;

  beforeEach(() => {
    getEmployeeIdForUser = jest.fn();
    grpcClient = { getService: jest.fn().mockReturnValue({ getEmployeeIdForUser }) };
    service = new EmployeeGrpcClientService(grpcClient as unknown as ClientGrpc);
    service.onModuleInit();
  });

  it("resolves the EmployeeService client from the ClientGrpc proxy by the proto's service name", () => {
    expect(grpcClient.getService).toHaveBeenCalledWith('EmployeeService');
  });

  it('returns the employeeId when the RPC finds a link', async () => {
    getEmployeeIdForUser.mockReturnValue(of({ found: true, employeeId: EMPLOYEE_ID }));

    await expect(service.getEmployeeIdForUser(TENANT_ID, USER_ID)).resolves.toBe(EMPLOYEE_ID);
    expect(getEmployeeIdForUser).toHaveBeenCalledWith({ tenantId: TENANT_ID, userId: USER_ID });
  });

  it('returns null when the RPC reports no link found', async () => {
    getEmployeeIdForUser.mockReturnValue(of({ found: false, employeeId: '' }));

    await expect(service.getEmployeeIdForUser(TENANT_ID, USER_ID)).resolves.toBeNull();
  });

  it('wraps a transport failure in EmployeeGrpcClientUnavailableError', async () => {
    getEmployeeIdForUser.mockReturnValue(throwError(() => new Error('UNAVAILABLE')));

    await expect(service.getEmployeeIdForUser(TENANT_ID, USER_ID)).rejects.toThrow(EmployeeGrpcClientUnavailableError);
  });
});

describe('EmployeeGrpcClientService.getSchedulableRoster (Attendance & Leave Manager Views phase)', () => {
  let getSchedulableEmployees: jest.Mock;
  let grpcClient: jest.Mocked<Pick<ClientGrpc, 'getService'>>;
  let service: EmployeeGrpcClientService;

  const roster = [
    {
      employeeId: EMPLOYEE_ID,
      employeeNumber: 'E1',
      orgUnitId: ORG_UNIT_ID,
      contractHoursPerWeek: 40,
      employmentType: 'full_time',
      hireDate: '2020-01-01',
    },
  ];

  beforeEach(() => {
    getSchedulableEmployees = jest.fn();
    grpcClient = { getService: jest.fn().mockReturnValue({ getSchedulableEmployees }) };
    service = new EmployeeGrpcClientService(grpcClient as unknown as ClientGrpc);
    service.onModuleInit();
  });

  it('requests the org-unit roster and collects the streamed response into an array', async () => {
    getSchedulableEmployees.mockReturnValue(of(...roster));

    await expect(service.getSchedulableRoster(TENANT_ID, ORG_UNIT_ID)).resolves.toEqual(roster);
    expect(getSchedulableEmployees).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orgUnitId: ORG_UNIT_ID,
      requiredSkillIds: [],
      minContractHoursPerWeek: 0,
      pageSize: 200,
    });
  });

  it('resolves an empty array when the org unit has no schedulable employees', async () => {
    getSchedulableEmployees.mockReturnValue(of());

    await expect(service.getSchedulableRoster(TENANT_ID, ORG_UNIT_ID)).resolves.toEqual([]);
  });

  it('wraps a transport failure in EmployeeGrpcClientUnavailableError', async () => {
    getSchedulableEmployees.mockReturnValue(throwError(() => new Error('UNAVAILABLE')));

    await expect(service.getSchedulableRoster(TENANT_ID, ORG_UNIT_ID)).rejects.toThrow(
      EmployeeGrpcClientUnavailableError,
    );
  });
});
