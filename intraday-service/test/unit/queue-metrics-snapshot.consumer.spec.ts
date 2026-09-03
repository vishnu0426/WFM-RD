import { QueueMetricsSnapshotConsumerService } from '../../src/live-state/queue-metrics-snapshot.consumer';

describe('QueueMetricsSnapshotConsumerService.handlePayload', () => {
  const payload = {
    tenantId: 't1',
    queueId: 'q1',
    currentVolume: 10,
    agentsAvailable: 3,
    agentsOnCall: 2,
    forecastedVolume: 12,
    serviceLevelCurrent: 0.8,
    serviceLevelTarget: 0.8,
  };

  it('inserts one snapshot row per event, scoped via SET LOCAL', async () => {
    const repository = { insert: jest.fn().mockResolvedValue(undefined) };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(repository),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const service = new QueueMetricsSnapshotConsumerService(undefined as never, dataSource as never);

    await service.handlePayload(payload);

    expect(repository.insert).toHaveBeenCalledTimes(1);
    expect(repository.insert.mock.calls[0][0]).toMatchObject({
      tenantId: 't1',
      queueId: 'q1',
      currentVolume: 10,
      agentsAvailable: 3,
      agentsOnCall: 2,
      forecastedVolume: 12,
      serviceLevelCurrent: 0.8,
      serviceLevelTarget: 0.8,
    });
    expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['app.current_tenant_id', 't1']);
  });
});
