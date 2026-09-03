import { of, throwError } from 'rxjs';
import { ClientGrpc } from '@nestjs/microservices';
import { AuditGrpcClientService } from '../../../src/grpc/audit-grpc-client.service';

describe('AuditGrpcClientService', () => {
  let recordEvent: jest.Mock;
  let grpcClient: jest.Mocked<Pick<ClientGrpc, 'getService'>>;
  let service: AuditGrpcClientService;

  const request = {
    tenantId: 'tenant-1',
    actorId: 'manager-1',
    actorType: 'user',
    action: 'approve_backdated_leave_request',
    resourceType: 'leave_request',
    resourceId: 'request-1',
    beforeStateJson: '{}',
    afterStateJson: '{}',
    aiRationaleJson: '',
  };

  beforeEach(() => {
    recordEvent = jest.fn();
    grpcClient = { getService: jest.fn().mockReturnValue({ recordEvent }) };
    service = new AuditGrpcClientService(grpcClient as unknown as ClientGrpc);
    service.onModuleInit();
  });

  it("resolves the AuditService client from the ClientGrpc proxy by the proto's service name", () => {
    expect(grpcClient.getService).toHaveBeenCalledWith('AuditService');
  });

  it('resolves without error when the call is accepted', async () => {
    recordEvent.mockReturnValue(of({ accepted: true, errorCode: '' }));
    await expect(service.recordEvent(request)).resolves.toBeUndefined();
    expect(recordEvent).toHaveBeenCalledWith(request);
  });

  it('throws when the response is accepted: false, surfacing the errorCode', async () => {
    recordEvent.mockReturnValue(of({ accepted: false, errorCode: 'AI_RATIONALE_REQUIRED' }));
    await expect(service.recordEvent(request)).rejects.toThrow('AI_RATIONALE_REQUIRED');
  });

  it('propagates a transport-level failure (e.g. core unreachable)', async () => {
    recordEvent.mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    await expect(service.recordEvent(request)).rejects.toThrow('UNAVAILABLE');
  });
});
