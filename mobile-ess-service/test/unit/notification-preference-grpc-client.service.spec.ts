import { of, throwError } from 'rxjs';
import { ClientGrpc } from '@nestjs/microservices';
import {
  NotificationPreferenceGrpcClientService,
  NotificationPreferenceGrpcClientUnavailableError,
} from '../../src/grpc/notification-preference-grpc-client.service';

describe('NotificationPreferenceGrpcClientService', () => {
  let isPushEnabled: jest.Mock;
  let grpcClient: jest.Mocked<Pick<ClientGrpc, 'getService'>>;
  let service: NotificationPreferenceGrpcClientService;

  beforeEach(() => {
    isPushEnabled = jest.fn();
    grpcClient = { getService: jest.fn().mockReturnValue({ isPushEnabled }) };
    service = new NotificationPreferenceGrpcClientService(grpcClient as unknown as ClientGrpc);
    service.onModuleInit();
  });

  it('returns the resolved response on a successful call', async () => {
    isPushEnabled.mockReturnValue(of({ enabled: true, employeeHasLinkedUser: true }));

    const result = await service.isPushEnabled({
      tenantId: 'tenant-1',
      employeeId: 'emp-1',
      eventType: 'leave.request.approved',
    });

    expect(result).toEqual({ enabled: true, employeeHasLinkedUser: true });
    expect(isPushEnabled).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      employeeId: 'emp-1',
      eventType: 'leave.request.approved',
    });
  });

  it('wraps a transport failure in NotificationPreferenceGrpcClientUnavailableError, naming the RPC', async () => {
    isPushEnabled.mockReturnValue(throwError(() => new Error('UNAVAILABLE')));

    await expect(
      service.isPushEnabled({ tenantId: 'tenant-1', employeeId: 'emp-1', eventType: 'leave.request.approved' }),
    ).rejects.toThrow(NotificationPreferenceGrpcClientUnavailableError);
    await expect(
      service.isPushEnabled({ tenantId: 'tenant-1', employeeId: 'emp-1', eventType: 'leave.request.approved' }),
    ).rejects.toThrow('IsPushEnabled');
  });
});
