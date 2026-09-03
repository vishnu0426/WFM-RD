import { of, throwError } from 'rxjs';
import { ClientGrpc } from '@nestjs/microservices';
import { CalendarGrpcClientService } from '../../../src/grpc/calendar-grpc-client.service';

describe('CalendarGrpcClientService', () => {
  let getWorkingTimeRules: jest.Mock;
  let grpcClient: jest.Mocked<Pick<ClientGrpc, 'getService'>>;
  let service: CalendarGrpcClientService;

  const request = { tenantId: 'tenant-1', orgUnitId: '', fromDate: '2026-01-01', toDate: '2026-12-31' };

  beforeEach(() => {
    getWorkingTimeRules = jest.fn();
    grpcClient = { getService: jest.fn().mockReturnValue({ getWorkingTimeRules }) };
    service = new CalendarGrpcClientService(grpcClient as unknown as ClientGrpc);
    service.onModuleInit();
  });

  it("resolves the CalendarService client from the ClientGrpc proxy by the proto's service name", () => {
    expect(grpcClient.getService).toHaveBeenCalledWith('CalendarService');
  });

  it('returns holidayDates on success', async () => {
    getWorkingTimeRules.mockReturnValue(
      of({ countryCode: 'US', timezone: 'UTC', holidayDates: ['2026-07-04'], standardBusinessHoursJson: '{}' }),
    );
    await expect(service.getWorkingTimeRules(request)).resolves.toEqual(
      expect.objectContaining({ holidayDates: ['2026-07-04'] }),
    );
    expect(getWorkingTimeRules).toHaveBeenCalledWith(request);
  });

  it('returns an empty holidayDates array, not an error, when no calendar is configured for the tenant', async () => {
    getWorkingTimeRules.mockReturnValue(
      of({ countryCode: '', timezone: 'UTC', holidayDates: [], standardBusinessHoursJson: '{}' }),
    );
    await expect(service.getWorkingTimeRules(request)).resolves.toEqual(expect.objectContaining({ holidayDates: [] }));
  });

  it('propagates a transport-level failure', async () => {
    getWorkingTimeRules.mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    await expect(service.getWorkingTimeRules(request)).rejects.toThrow('UNAVAILABLE');
  });
});
