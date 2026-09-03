import { AttendanceLeaveNatsClientService } from '../../../src/nats/nats-client.service';

const mockJsPublish = jest.fn();
const mockJetstream = jest.fn().mockReturnValue({ publish: mockJsPublish });
const mockDrain = jest.fn();
const mockConnect = jest.fn();

// Jest hoists `jest.mock` calls above imports regardless of source order,
// so `AttendanceLeaveNatsClientService` above still picks up this mock.
jest.mock('nats', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  StringCodec: () => ({ encode: (s: string) => Buffer.from(s), decode: (b: Buffer) => b.toString() }),
}));

describe('AttendanceLeaveNatsClientService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue({ jetstream: mockJetstream, drain: mockDrain });
  });

  it('publishes JSON-encoded payload to the given subject', async () => {
    const service = new AttendanceLeaveNatsClientService();
    await service.publish('agno.leave.request.approved.v1', { foo: 'bar' });
    expect(mockJsPublish).toHaveBeenCalledWith('agno.leave.request.approved.v1', expect.anything(), undefined);
  });

  it('passes msgId through as JetStream msgID for dedup when provided', async () => {
    const service = new AttendanceLeaveNatsClientService();
    await service.publish('agno.leave.request.approved.v1', { foo: 'bar' }, 'request-1');
    expect(mockJsPublish).toHaveBeenCalledWith('agno.leave.request.approved.v1', expect.anything(), {
      msgID: 'request-1',
    });
  });

  it('reuses an existing connection across publishes rather than reconnecting each time', async () => {
    const service = new AttendanceLeaveNatsClientService();
    await service.publish('subject.a', {});
    await service.publish('subject.b', {});
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('propagates a connection failure to the caller (fail-visible, no swallowing)', async () => {
    mockConnect.mockRejectedValue(new Error('ECONNREFUSED'));
    const service = new AttendanceLeaveNatsClientService();
    await expect(service.publish('subject.a', {})).rejects.toThrow('ECONNREFUSED');
  });

  it('drains the connection on module destroy', async () => {
    const service = new AttendanceLeaveNatsClientService();
    await service.publish('subject.a', {});
    await service.onModuleDestroy();
    expect(mockDrain).toHaveBeenCalled();
  });
});
