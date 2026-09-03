import { of, throwError } from 'rxjs';
import {
  EmployeeGrpcClientService,
  EmployeeGrpcClientUnavailableError,
} from '../../src/grpc/employee-grpc-client.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333';

function buildClient(getEmployeeIdForUser: jest.Mock) {
  const grpcClient = { getService: jest.fn().mockReturnValue({ getEmployeeIdForUser }) };
  const service = new EmployeeGrpcClientService(grpcClient as never);
  service.onModuleInit();
  return service;
}

describe('EmployeeGrpcClientService.getEmployeeIdForUser (ADR-0150/ADR-0157)', () => {
  it('returns the employeeId when the RPC finds a link', async () => {
    const service = buildClient(jest.fn().mockReturnValue(of({ found: true, employeeId: EMPLOYEE_ID })));

    await expect(service.getEmployeeIdForUser(TENANT_ID, USER_ID)).resolves.toBe(EMPLOYEE_ID);
  });

  it('returns null when the RPC reports no link found', async () => {
    const service = buildClient(jest.fn().mockReturnValue(of({ found: false, employeeId: '' })));

    await expect(service.getEmployeeIdForUser(TENANT_ID, USER_ID)).resolves.toBeNull();
  });

  it('wraps a transport failure in EmployeeGrpcClientUnavailableError', async () => {
    const service = buildClient(jest.fn().mockReturnValue(throwError(() => new Error('unavailable'))));

    await expect(service.getEmployeeIdForUser(TENANT_ID, USER_ID)).rejects.toThrow(EmployeeGrpcClientUnavailableError);
  });
});
