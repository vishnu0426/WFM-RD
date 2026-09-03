import { of, throwError } from 'rxjs';
import { ClientGrpc } from '@nestjs/microservices';
import {
  EmployeeGrpcClientService,
  EmployeeGrpcClientUnavailableError,
} from '../../../src/grpc/employee-grpc-client.service';

describe('EmployeeGrpcClientService', () => {
  let getEmployeeOrgUnits: jest.Mock;
  let getSchedulableEmployees: jest.Mock;
  let grpcClient: jest.Mocked<Pick<ClientGrpc, 'getService'>>;
  let service: EmployeeGrpcClientService;

  beforeEach(() => {
    getEmployeeOrgUnits = jest.fn();
    getSchedulableEmployees = jest.fn();
    grpcClient = { getService: jest.fn().mockReturnValue({ getEmployeeOrgUnits, getSchedulableEmployees }) };
    service = new EmployeeGrpcClientService(grpcClient as unknown as ClientGrpc);
    service.onModuleInit();
  });

  describe('getSchedulableRoster', () => {
    it('collects every streamed employee into one array, with a fixed page size and no skill filter', async () => {
      const employee = {
        employeeId: 'emp-1',
        employeeNumber: 'E-1',
        orgUnitId: 'org-1',
        contractHoursPerWeek: 40,
        employmentType: 'full_time',
        hireDate: '2020-01-01',
      };
      getSchedulableEmployees.mockReturnValue(of(employee));

      const result = await service.getSchedulableRoster('tenant-1', 'org-1');

      expect(result).toEqual([employee]);
      expect(getSchedulableEmployees).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        orgUnitId: 'org-1',
        requiredSkillIds: [],
        minContractHoursPerWeek: 0,
        pageSize: 200,
      });
    });

    it('wraps a transport failure in EmployeeGrpcClientUnavailableError, naming the RPC', async () => {
      getSchedulableEmployees.mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
      await expect(service.getSchedulableRoster('tenant-1', 'org-1')).rejects.toThrow(
        EmployeeGrpcClientUnavailableError,
      );
      await expect(service.getSchedulableRoster('tenant-1', 'org-1')).rejects.toThrow('GetSchedulableEmployees');
    });
  });

  describe('getEmployeeOrgUnits', () => {
    it('returns [] without calling the client when employeeIds is empty', async () => {
      const result = await service.getEmployeeOrgUnits('tenant-1', []);
      expect(result).toEqual([]);
      expect(getEmployeeOrgUnits).not.toHaveBeenCalled();
    });

    it('wraps a transport failure in EmployeeGrpcClientUnavailableError, naming the RPC', async () => {
      getEmployeeOrgUnits.mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
      await expect(service.getEmployeeOrgUnits('tenant-1', ['emp-1'])).rejects.toThrow('GetEmployeeOrgUnits');
    });
  });
});
