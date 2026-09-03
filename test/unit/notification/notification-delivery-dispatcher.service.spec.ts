import { NotificationDeliveryDispatcherService } from '../../../src/modules/notification/services/notification-delivery-dispatcher.service';
import { NotificationChannel } from '../../../src/modules/notification/entities/notification-channel.enum';

const TENANT_ID = 'tenant-1';

function delivery(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'delivery-1',
    tenantId: TENANT_ID,
    userId: 'user-1',
    channel: NotificationChannel.EMAIL,
    eventType: 'skill_expiring',
    payload: { skillId: 'skill-1' },
    status: 'pending',
    createdAt: new Date(),
    sentAt: null,
    claimedAt: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}

function makeAdapter(channel: NotificationChannel, send: jest.Mock) {
  return { channel, send };
}

describe('NotificationDeliveryDispatcherService (GAP-05 fix, enterprise readiness audit 2026-08-18)', () => {
  let deliveryRepository: {
    findPendingBatch: jest.Mock;
    markSent: jest.Mock;
    markSkipped: jest.Mock;
    recordFailure: jest.Mock;
  };

  beforeEach(() => {
    deliveryRepository = {
      findPendingBatch: jest.fn().mockResolvedValue([]),
      markSent: jest.fn().mockResolvedValue(undefined),
      markSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('sends via the adapter registered for the delivery channel and marks it sent on success', async () => {
    const row = delivery();
    deliveryRepository.findPendingBatch.mockResolvedValue([row]);
    const send = jest.fn().mockResolvedValue(undefined);
    const adapter = makeAdapter(NotificationChannel.EMAIL, send);

    const service = new NotificationDeliveryDispatcherService(deliveryRepository as never, [adapter] as never);
    await service.tick();

    expect(send).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: 'user-1',
      channel: NotificationChannel.EMAIL,
      eventType: 'skill_expiring',
      payload: { skillId: 'skill-1' },
    });
    expect(deliveryRepository.markSent).toHaveBeenCalledWith('delivery-1');
    expect(deliveryRepository.recordFailure).not.toHaveBeenCalled();
  });

  it('records a failure (retryable) when the adapter throws, below the give-up threshold', async () => {
    const row = delivery({ attempts: 1 });
    deliveryRepository.findPendingBatch.mockResolvedValue([row]);
    const send = jest.fn().mockRejectedValue(new Error('smtp timeout'));
    const adapter = makeAdapter(NotificationChannel.EMAIL, send);

    const service = new NotificationDeliveryDispatcherService(deliveryRepository as never, [adapter] as never);
    await service.tick();

    expect(deliveryRepository.recordFailure).toHaveBeenCalledWith('delivery-1', 'smtp timeout', false);
    expect(deliveryRepository.markSent).not.toHaveBeenCalled();
  });

  it('gives up (exhausted=true) after the 5th failed attempt', async () => {
    const row = delivery({ attempts: 4 });
    deliveryRepository.findPendingBatch.mockResolvedValue([row]);
    const send = jest.fn().mockRejectedValue(new Error('smtp down'));
    const adapter = makeAdapter(NotificationChannel.EMAIL, send);

    const service = new NotificationDeliveryDispatcherService(deliveryRepository as never, [adapter] as never);
    await service.tick();

    expect(deliveryRepository.recordFailure).toHaveBeenCalledWith('delivery-1', 'smtp down', true);
  });

  it('marks skipped, not failed, when no adapter is registered for the channel', async () => {
    const row = delivery({ channel: NotificationChannel.SMS });
    deliveryRepository.findPendingBatch.mockResolvedValue([row]);
    const send = jest.fn();
    const adapter = makeAdapter(NotificationChannel.EMAIL, send);

    const service = new NotificationDeliveryDispatcherService(deliveryRepository as never, [adapter] as never);
    await service.tick();

    expect(send).not.toHaveBeenCalled();
    expect(deliveryRepository.markSkipped).toHaveBeenCalledWith('delivery-1');
    expect(deliveryRepository.recordFailure).not.toHaveBeenCalled();
  });

  it('re-entrancy guard: a tick already in flight is not started a second time', async () => {
    // A real (macrotask) async gap inside `send`, not a manually-resolved
    // promise - `tick()` sets `this.ticking = true` synchronously before
    // either call's `drain()` reaches its own first `await`, so calling
    // `tick()` twice back-to-back (same synchronous expression, same as
    // production callers never do but this test needs to force the race)
    // deterministically exercises the guard regardless of how long `send`
    // takes to settle.
    const send = jest.fn().mockImplementation(() => new Promise<void>((resolve) => setImmediate(resolve)));
    const adapter = makeAdapter(NotificationChannel.EMAIL, send);
    deliveryRepository.findPendingBatch.mockResolvedValue([delivery()]);

    const service = new NotificationDeliveryDispatcherService(deliveryRepository as never, [adapter] as never);
    await Promise.all([service.tick(), service.tick()]);

    expect(deliveryRepository.findPendingBatch).toHaveBeenCalledTimes(1);
  });
});
