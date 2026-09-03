import { LiveStateRestController } from '../../src/live-state/live-state-rest.controller';
import { QueueNotFoundError } from '../../src/common/errors/queue-not-found.error';

describe('LiveStateRestController.getQueueLive', () => {
  it('returns the queue live state for a known queue', async () => {
    const result = { queueId: 'q1', currentVolume: 5 };
    const queueLiveState = { getQueueLiveState: jest.fn().mockResolvedValue(result) };
    const tenantContext = { requireTenantId: jest.fn().mockReturnValue('t1') };
    const controller = new LiveStateRestController(queueLiveState as never, tenantContext as never);

    await expect(controller.getQueueLive('q1')).resolves.toBe(result);
    expect(queueLiveState.getQueueLiveState).toHaveBeenCalledWith('t1', 'q1');
  });

  it('throws QueueNotFoundError (mapped to 404 by DomainErrorFilter) when nothing is known about the queue', async () => {
    const queueLiveState = { getQueueLiveState: jest.fn().mockResolvedValue(null) };
    const tenantContext = { requireTenantId: jest.fn().mockReturnValue('t1') };
    const controller = new LiveStateRestController(queueLiveState as never, tenantContext as never);

    await expect(controller.getQueueLive('q1')).rejects.toThrow(QueueNotFoundError);
  });
});
