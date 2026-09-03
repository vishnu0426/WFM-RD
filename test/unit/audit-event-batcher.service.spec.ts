import { AuditEventBatcherService } from '../../src/modules/audit/services/audit-event-batcher.service';
import { AuditActorType } from '../../src/modules/audit/entities/audit-actor-type.enum';
import { AiRationaleRequiredError } from '../../src/modules/audit/errors/ai-rationale-required.error';

describe('AuditEventBatcherService', () => {
  const makeEvent = (overrides: Partial<Record<string, unknown>> = {}) => ({
    tenantId: 'tenant-1',
    actorId: 'user-1',
    actorType: AuditActorType.USER,
    action: 'test.action',
    resourceType: 'test_resource',
    resourceId: null,
    beforeState: null,
    afterState: null,
    aiRationale: null,
    ...overrides,
  });

  const makePendingRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'pending-1',
    attempts: 0,
    ...makeEvent(),
    ...overrides,
  });

  const makeDeps = () => {
    const auditLogRepository = { record: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    const tenantContext = { run: jest.fn((_ctx: unknown, fn: () => unknown) => fn()) };
    const natsClient = { publish: jest.fn().mockResolvedValue(undefined) };
    const pendingEvents = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      findBatch: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    return { auditLogRepository, tenantContext, natsClient, pendingEvents };
  };

  const makeService = (deps: ReturnType<typeof makeDeps>) =>
    new AuditEventBatcherService(
      deps.auditLogRepository as never,
      deps.tenantContext as never,
      deps.natsClient as never,
      deps.pendingEvents as never,
    );

  it('enqueue rejects an ai_agent event with no ai_rationale synchronously (§2.2 rule 3), before any durable insert', () => {
    const deps = makeDeps();
    const service = makeService(deps);

    expect(() =>
      service.enqueue(makeEvent({ actorType: AuditActorType.AI_AGENT, aiRationale: null }) as never),
    ).toThrow(AiRationaleRequiredError);
    expect(deps.pendingEvents.enqueue).not.toHaveBeenCalled();
  });

  it('enqueue accepts an ai_agent event with ai_rationale present and durably inserts it', () => {
    const deps = makeDeps();
    const service = makeService(deps);

    service.enqueue(makeEvent({ actorType: AuditActorType.AI_AGENT, aiRationale: { reason: 'because' } }) as never);
    expect(deps.pendingEvents.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: AuditActorType.AI_AGENT }),
    );
  });

  it('logs (but does not throw) if the durable insert itself fails - fire-and-forget from the caller', async () => {
    const deps = makeDeps();
    deps.pendingEvents.enqueue.mockRejectedValueOnce(new Error('db unreachable'));
    const service = makeService(deps);

    expect(() => service.enqueue(makeEvent() as never)).not.toThrow();
    // let the rejected promise's .catch handler run
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('flush reads a batch from the durable queue, groups by tenant, writes each to audit_log, and deletes the row', async () => {
    const deps = makeDeps();
    deps.pendingEvents.findBatch.mockResolvedValue([
      makePendingRow({ id: 'p-1', tenantId: 'tenant-a' }),
      makePendingRow({ id: 'p-2', tenantId: 'tenant-b' }),
      makePendingRow({ id: 'p-3', tenantId: 'tenant-a' }),
    ]);
    const service = makeService(deps);

    await service.flush();

    expect(deps.auditLogRepository.record).toHaveBeenCalledTimes(3);
    expect(deps.tenantContext.run).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, expect.any(Function));
    expect(deps.tenantContext.run).toHaveBeenCalledWith({ tenantId: 'tenant-b' }, expect.any(Function));
    expect(deps.pendingEvents.delete).toHaveBeenCalledWith('p-1');
    expect(deps.pendingEvents.delete).toHaveBeenCalledWith('p-2');
    expect(deps.pendingEvents.delete).toHaveBeenCalledWith('p-3');
  });

  it('a flush failure increments the durable row`s attempts instead of dropping it', async () => {
    const deps = makeDeps();
    deps.auditLogRepository.record.mockRejectedValueOnce(new Error('db unavailable'));
    deps.pendingEvents.findBatch.mockResolvedValue([makePendingRow({ attempts: 0 })]);
    const service = makeService(deps);

    await service.flush();

    expect(deps.pendingEvents.recordFailure).toHaveBeenCalledWith('pending-1', 'db unavailable');
    expect(deps.pendingEvents.delete).not.toHaveBeenCalled();
    expect(deps.natsClient.publish).not.toHaveBeenCalled(); // hasn't exhausted retries yet
  });

  it('exhausting retries routes the row to the DLQ subject and deletes it from the durable queue', async () => {
    const deps = makeDeps();
    deps.auditLogRepository.record.mockRejectedValue(new Error('db unavailable'));
    // attempts already at FLUSH_MAX_RETRIES - 1 (=2), so this flush is the exhausting one.
    deps.pendingEvents.findBatch.mockResolvedValue([makePendingRow({ attempts: 2 })]);
    const service = makeService(deps);

    await service.flush();

    expect(deps.natsClient.publish).toHaveBeenCalledWith(
      'agno.core.dlq.v1',
      expect.objectContaining({ originalSubject: 'agno.core.audit.created.v1' }),
    );
    expect(deps.pendingEvents.delete).toHaveBeenCalledWith('pending-1');
    expect(deps.pendingEvents.recordFailure).not.toHaveBeenCalled();
  });

  it('if the DLQ publish also fails, the row is kept (not deleted) for the next tick to retry', async () => {
    const deps = makeDeps();
    deps.auditLogRepository.record.mockRejectedValue(new Error('db unavailable'));
    deps.natsClient.publish.mockRejectedValue(new Error('nats unreachable'));
    deps.pendingEvents.findBatch.mockResolvedValue([makePendingRow({ attempts: 2 })]);
    const service = makeService(deps);

    await service.flush();

    expect(deps.pendingEvents.delete).not.toHaveBeenCalled();
    expect(deps.pendingEvents.recordFailure).toHaveBeenCalledWith(
      'pending-1',
      expect.stringContaining('DLQ publish also failed'),
    );
  });

  it('onModuleDestroy performs a best-effort final flush', async () => {
    const deps = makeDeps();
    deps.pendingEvents.findBatch.mockResolvedValue([makePendingRow()]);
    const service = makeService(deps);

    await service.onModuleDestroy();

    expect(deps.auditLogRepository.record).toHaveBeenCalledTimes(1);
  });
});
