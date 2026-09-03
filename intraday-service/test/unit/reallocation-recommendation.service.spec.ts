import { ReallocationRecommendationService } from '../../src/reallocation/reallocation-recommendation.service';
import { reallocationSuggestedTrigger } from '../../src/graphql/subscription-triggers';
import { INTRADAY_SUBJECTS } from '../../src/nats/subjects';

describe('ReallocationRecommendationService.evaluateQueueMetrics', () => {
  const targetRecord = {
    currentVolume: 20,
    agentsAvailable: 1,
    agentsOnCall: 4,
    forecastedVolume: 22,
    serviceLevelCurrent: 0.6,
    serviceLevelTarget: 0.8,
    lastUpdatedAt: '2026-08-07T10:00:00.000Z',
  };

  const surplusDonorRecord = {
    currentVolume: 5,
    agentsAvailable: 3,
    agentsOnCall: 1,
    forecastedVolume: 5,
    serviceLevelCurrent: 0.95,
    serviceLevelTarget: 0.8,
    lastUpdatedAt: '2026-08-07T10:00:00.000Z',
  };

  const makeManager = (repository: unknown) => ({
    query: jest.fn().mockResolvedValue(undefined),
    getRepository: jest.fn().mockReturnValue(repository),
  });
  const makeDataSource = (manager: unknown) => ({
    transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
  });
  const makeRepository = (existing: unknown = null) => ({
    findOne: jest.fn().mockResolvedValue(existing),
    save: jest.fn().mockResolvedValue(undefined),
  });

  function makeService(opts: {
    trackedQueues?: string[];
    queueStates?: Record<string, unknown>;
    queueMembers?: Record<string, string[]>;
    repository?: ReturnType<typeof makeRepository>;
    autoExecute?: boolean;
    natsPublish?: jest.Mock;
  }) {
    const repository = opts.repository ?? makeRepository();
    const manager = makeManager(repository);
    const dataSource = makeDataSource(manager);
    const redis = {
      listTrackedQueues: jest.fn().mockResolvedValue(opts.trackedQueues ?? []),
      readQueueLiveState: jest
        .fn()
        .mockImplementation(async (_t: string, queueId: string) => (opts.queueStates ?? {})[queueId] ?? null),
      listQueueMembers: jest
        .fn()
        .mockImplementation(async (_t: string, queueId: string) => (opts.queueMembers ?? {})[queueId] ?? []),
    };
    const nats = { publish: opts.natsPublish ?? jest.fn().mockResolvedValue(undefined) };
    const execution = { applyReallocation: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn().mockReturnValue(opts.autoExecute ? 'true' : 'false') };
    const pubSub = { publish: jest.fn().mockResolvedValue(undefined) };

    const service = new ReallocationRecommendationService(
      dataSource as never,
      redis as never,
      nats as never,
      execution as never,
      config as never,
      pubSub as never,
    );
    return { service, repository, redis, nats, execution, pubSub };
  }

  it('does nothing when the queue is not breaching its target', async () => {
    const { service, repository } = makeService({});

    await service.evaluateQueueMetrics('t1', 'q1', { ...targetRecord, serviceLevelCurrent: 0.9 });

    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('does nothing when serviceLevelCurrent/Target is null', async () => {
    const { service, repository } = makeService({});

    await service.evaluateQueueMetrics('t1', 'q1', { ...targetRecord, serviceLevelCurrent: null });

    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('does nothing when no tracked queue has a qualifying surplus', async () => {
    const { service, repository } = makeService({
      trackedQueues: ['q2'],
      queueStates: { q2: { ...surplusDonorRecord, serviceLevelCurrent: 0.85 } }, // only 5pp surplus, below the 10pp threshold
    });

    await service.evaluateQueueMetrics('t1', 'q1', targetRecord);

    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('excludes a candidate donor with zero agentsAvailable even if its surplus qualifies', async () => {
    const { service, repository } = makeService({
      trackedQueues: ['q2'],
      queueStates: { q2: { ...surplusDonorRecord, agentsAvailable: 0 } },
    });

    await service.evaluateQueueMetrics('t1', 'q1', targetRecord);

    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('never considers the breaching queue itself as its own donor', async () => {
    const { service, repository } = makeService({
      trackedQueues: ['q1'],
      queueStates: { q1: surplusDonorRecord },
    });

    await service.evaluateQueueMetrics('t1', 'q1', targetRecord);

    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('does nothing when a qualifying donor has no tracked members (never fabricates affected_employee_ids)', async () => {
    const { service, repository } = makeService({
      trackedQueues: ['q2'],
      queueStates: { q2: surplusDonorRecord },
      queueMembers: {},
    });

    await service.evaluateQueueMetrics('t1', 'q1', targetRecord);

    expect(repository.findOne).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('picks the donor with the largest surplus among multiple qualifying candidates', async () => {
    const { service, repository, redis } = makeService({
      trackedQueues: ['q2', 'q3'],
      queueStates: {
        q2: { ...surplusDonorRecord, serviceLevelCurrent: 0.92 }, // 12pp surplus
        q3: { ...surplusDonorRecord, serviceLevelCurrent: 0.98 }, // 18pp surplus - larger
      },
      queueMembers: { q2: ['e-q2'], q3: ['e-q3'] },
    });

    await service.evaluateQueueMetrics('t1', 'q1', targetRecord);

    expect(redis.listQueueMembers).toHaveBeenCalledWith('t1', 'q3');
    const inserted = repository.save.mock.calls[0][0];
    expect(inserted.fromQueueId).toBe('q3');
    expect(inserted.affectedEmployeeIds).toEqual(['e-q3']);
  });

  it('creates a suggested row with a real, deterministic ai_rationale and publishes to NATS + PubSub', async () => {
    const { service, repository, nats, pubSub } = makeService({
      trackedQueues: ['q2'],
      queueStates: { q2: surplusDonorRecord },
      queueMembers: { q2: ['e1'] },
    });

    await service.evaluateQueueMetrics('t1', 'q1', targetRecord);

    const inserted = repository.save.mock.calls[0][0];
    expect(inserted).toMatchObject({
      tenantId: 't1',
      triggeredBy: 'system_recommendation',
      fromQueueId: 'q2',
      toQueueId: 'q1',
      affectedEmployeeIds: ['e1'],
      status: 'suggested',
    });
    expect(inserted.aiRationale).toMatchObject({
      triggerMetric: 'service_level_current',
      heuristic: 'largest_service_level_surplus_donor',
    });
    expect(nats.publish).toHaveBeenCalledWith(
      INTRADAY_SUBJECTS.REALLOCATION_SUGGESTED,
      expect.objectContaining({ tenantId: 't1', fromQueueId: 'q2', toQueueId: 'q1' }),
    );
    expect(pubSub.publish).toHaveBeenCalledWith(
      reallocationSuggestedTrigger('t1'),
      expect.objectContaining({ reallocationSuggested: expect.objectContaining({ status: 'suggested' }) }),
    );
  });

  it('the repeat-guard skips creating a new row when one is already suggested/approved for the same pair', async () => {
    const repository = makeRepository({ id: 'existing', status: 'suggested' });
    const { service } = makeService({
      repository,
      trackedQueues: ['q2'],
      queueStates: { q2: surplusDonorRecord },
      queueMembers: { q2: ['e1'] },
    });

    await service.evaluateQueueMetrics('t1', 'q1', targetRecord);

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('a NATS publish failure is logged, not thrown, and the PubSub push still happens', async () => {
    const { service, pubSub } = makeService({
      trackedQueues: ['q2'],
      queueStates: { q2: surplusDonorRecord },
      queueMembers: { q2: ['e1'] },
      natsPublish: jest.fn().mockRejectedValue(new Error('nats down')),
    });

    await expect(service.evaluateQueueMetrics('t1', 'q1', targetRecord)).resolves.toBeUndefined();
    expect(pubSub.publish).toHaveBeenCalled();
  });

  it('when auto-execute is enabled, immediately applies the reallocation and marks the row auto_executed', async () => {
    const { service, repository, execution } = makeService({
      trackedQueues: ['q2'],
      queueStates: { q2: surplusDonorRecord },
      queueMembers: { q2: ['e1'] },
      autoExecute: true,
    });

    await service.evaluateQueueMetrics('t1', 'q1', targetRecord);

    expect(execution.applyReallocation).toHaveBeenCalledWith('t1', 'q2', 'q1', ['e1']);
    const finalSave = repository.save.mock.calls[repository.save.mock.calls.length - 1][0];
    expect(finalSave.status).toBe('auto_executed');
    expect(finalSave.executedAt).toBeInstanceOf(Date);
  });

  it('when auto-execute is disabled (default), the row stays suggested and applyReallocation is never called', async () => {
    const { service, repository, execution } = makeService({
      trackedQueues: ['q2'],
      queueStates: { q2: surplusDonorRecord },
      queueMembers: { q2: ['e1'] },
      autoExecute: false,
    });

    await service.evaluateQueueMetrics('t1', 'q1', targetRecord);

    expect(execution.applyReallocation).not.toHaveBeenCalled();
    expect(repository.save.mock.calls[0][0].status).toBe('suggested');
  });
});
