import { OutboxPublisherService } from '../../src/modules/eventing/services/outbox-publisher.service';
import { SUBJECTS } from '../../src/modules/eventing/subjects';

describe('OutboxPublisherService', () => {
  const makeEvent = (overrides: Partial<{ id: string; subject: string; attempts: number }> = {}) => ({
    id: overrides.id ?? 'event-1',
    tenantId: 'tenant-1',
    subject: overrides.subject ?? 'agno.org.employee.changed.v1',
    payload: { foo: 'bar' },
    createdAt: new Date(),
    publishedAt: null,
    attempts: overrides.attempts ?? 0,
    lastError: null,
  });

  it('marks an event published on successful NATS publish', async () => {
    const event = makeEvent();
    const outboxEventsRepository = {
      findUnpublishedBatch: jest.fn().mockResolvedValue([event]),
      markPublished: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn(),
    };
    const natsClient = { publish: jest.fn().mockResolvedValue(undefined) };

    const service = new OutboxPublisherService(outboxEventsRepository as never, natsClient as never);
    await service.tick();

    // GAP-14: publish now also carries the outbox row's own id as msgId, so
    // JetStream can de-dupe a retried publish (e.g. after a reclaimed lease).
    expect(natsClient.publish).toHaveBeenCalledWith(event.subject, event.payload, event.id);
    expect(outboxEventsRepository.markPublished).toHaveBeenCalledWith(event.id);
    expect(outboxEventsRepository.recordFailure).not.toHaveBeenCalled();
  });

  it('records a failure (not published) when NATS publish rejects and attempts is below the DLQ threshold', async () => {
    const event = makeEvent({ attempts: 1 });
    const outboxEventsRepository = {
      findUnpublishedBatch: jest.fn().mockResolvedValue([event]),
      markPublished: jest.fn(),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    const natsClient = { publish: jest.fn().mockRejectedValue(new Error('connection refused')) };

    const service = new OutboxPublisherService(outboxEventsRepository as never, natsClient as never);
    await service.tick();

    expect(outboxEventsRepository.recordFailure).toHaveBeenCalledWith(event.id, 'connection refused');
    expect(outboxEventsRepository.markPublished).not.toHaveBeenCalled();
  });

  it('routes to the DLQ subject once attempts reaches the threshold, and marks it published so it stops retrying the original subject', async () => {
    const event = makeEvent({ attempts: 4 }); // 4 + 1 = 5 = MAX_ATTEMPTS_BEFORE_DLQ
    const outboxEventsRepository = {
      findUnpublishedBatch: jest.fn().mockResolvedValue([event]),
      markPublished: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    const publishCalls: string[] = [];
    const natsClient = {
      publish: jest.fn().mockImplementation((subject: string) => {
        publishCalls.push(subject);
        if (subject === event.subject) {
          return Promise.reject(new Error('still down'));
        }
        return Promise.resolve(undefined);
      }),
    };

    const service = new OutboxPublisherService(outboxEventsRepository as never, natsClient as never);
    await service.tick();

    expect(publishCalls).toEqual([event.subject, SUBJECTS.DLQ]);
    expect(outboxEventsRepository.markPublished).toHaveBeenCalledWith(event.id);
    expect(outboxEventsRepository.recordFailure).not.toHaveBeenCalled();
  });

  it('leaves the event unpublished and records a compound failure if even the DLQ publish fails', async () => {
    const event = makeEvent({ attempts: 4 });
    const outboxEventsRepository = {
      findUnpublishedBatch: jest.fn().mockResolvedValue([event]),
      markPublished: jest.fn(),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    const natsClient = { publish: jest.fn().mockRejectedValue(new Error('nats unreachable')) };

    const service = new OutboxPublisherService(outboxEventsRepository as never, natsClient as never);
    await service.tick();

    expect(outboxEventsRepository.markPublished).not.toHaveBeenCalled();
    expect(outboxEventsRepository.recordFailure).toHaveBeenCalledWith(
      event.id,
      expect.stringContaining('DLQ publish also failed'),
    );
  });
});
