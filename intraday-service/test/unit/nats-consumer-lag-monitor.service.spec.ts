import { NatsConsumerLagMonitorService } from '../../src/consumers/nats-consumer-lag-monitor.service';
import { INTRADAY_STREAM_NAME } from '../../src/nats/subjects';

describe('NatsConsumerLagMonitorService.tick', () => {
  it('sets the lag gauge for every known durable consumer from a real consumers.info call', async () => {
    const jsm = { consumers: { info: jest.fn().mockResolvedValue({ num_pending: 7 }) } };
    const conn = { jetstreamManager: jest.fn().mockResolvedValue(jsm) };
    const natsClient = { getConnection: jest.fn().mockResolvedValue(conn) };
    const metrics = { setNatsConsumerLag: jest.fn() };
    const service = new NatsConsumerLagMonitorService(natsClient as never, metrics as never);

    await service.tick();

    expect(jsm.consumers.info).toHaveBeenCalledWith(INTRADAY_STREAM_NAME, 'intraday-agent-state-changed');
    expect(jsm.consumers.info).toHaveBeenCalledWith(INTRADAY_STREAM_NAME, 'intraday-queue-metrics-updated');
    expect(metrics.setNatsConsumerLag).toHaveBeenCalledWith('intraday-agent-state-changed', 7);
    expect(metrics.setNatsConsumerLag.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('skips (does not throw) a consumer that has not bound yet', async () => {
    const jsm = {
      consumers: {
        info: jest.fn().mockImplementation(async (_stream: string, durableName: string) => {
          if (durableName === 'intraday-assignment-changed') {
            throw new Error('consumer not found');
          }
          return { num_pending: 0 };
        }),
      },
    };
    const conn = { jetstreamManager: jest.fn().mockResolvedValue(jsm) };
    const natsClient = { getConnection: jest.fn().mockResolvedValue(conn) };
    const metrics = { setNatsConsumerLag: jest.fn() };
    const service = new NatsConsumerLagMonitorService(natsClient as never, metrics as never);

    await expect(service.tick()).resolves.toBeUndefined();

    expect(metrics.setNatsConsumerLag).not.toHaveBeenCalledWith('intraday-assignment-changed', expect.anything());
  });

  it('is a no-op (does not throw) when NATS itself is unavailable', async () => {
    const natsClient = { getConnection: jest.fn().mockRejectedValue(new Error('nats down')) };
    const metrics = { setNatsConsumerLag: jest.fn() };
    const service = new NatsConsumerLagMonitorService(natsClient as never, metrics as never);

    await expect(service.tick()).resolves.toBeUndefined();
    expect(metrics.setNatsConsumerLag).not.toHaveBeenCalled();
  });
});
