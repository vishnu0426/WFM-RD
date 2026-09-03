import { StaffingOfferService } from '../../src/staffing-offers/staffing-offer.service';
import { INTRADAY_SUBJECTS } from '../../src/nats/subjects';

describe('StaffingOfferService.evaluateQueueMetrics', () => {
  const baseRecord = {
    currentVolume: 20,
    agentsAvailable: 1,
    agentsOnCall: 4,
    forecastedVolume: 22,
    serviceLevelCurrent: 0.8,
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
  const makeRepository = (existingByEmployee: Record<string, unknown> = {}) => ({
    findOne: jest
      .fn()
      .mockImplementation(
        async ({ where }: { where: { employeeId: string } }) => existingByEmployee[where.employeeId] ?? null,
      ),
    save: jest.fn().mockResolvedValue(undefined),
  });

  function makeService(opts: {
    queueMembers?: string[];
    repository?: ReturnType<typeof makeRepository>;
    natsPublish?: jest.Mock;
  }) {
    const repository = opts.repository ?? makeRepository();
    const manager = makeManager(repository);
    const dataSource = makeDataSource(manager);
    const redis = { listQueueMembers: jest.fn().mockResolvedValue(opts.queueMembers ?? []) };
    const nats = { publish: opts.natsPublish ?? jest.fn().mockResolvedValue(undefined) };

    const service = new StaffingOfferService(dataSource as never, redis as never, nats as never);
    return { service, repository, redis, nats };
  }

  it('does nothing when serviceLevelCurrent/Target is null', async () => {
    const { service, repository } = makeService({});

    await service.evaluateQueueMetrics('t1', 'q1', { ...baseRecord, serviceLevelCurrent: null });

    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('does nothing when the queue is within threshold of its target either way', async () => {
    const { service, redis } = makeService({ queueMembers: ['e1'] });

    await service.evaluateQueueMetrics('t1', 'q1', { ...baseRecord, serviceLevelCurrent: 0.85 }); // only 5pp surplus

    expect(redis.listQueueMembers).not.toHaveBeenCalled();
  });

  it('offers VTO to every tracked queue member when surplus exceeds the threshold', async () => {
    const { service, repository, nats } = makeService({ queueMembers: ['e1', 'e2'] });

    await service.evaluateQueueMetrics('t1', 'q1', { ...baseRecord, serviceLevelCurrent: 0.95 }); // 15pp surplus

    expect(repository.save).toHaveBeenCalledTimes(2);
    const [first, second] = repository.save.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({
      tenantId: 't1',
      queueId: 'q1',
      offerType: 'vto',
      employeeId: 'e1',
      status: 'offered',
    });
    expect(second).toMatchObject({
      tenantId: 't1',
      queueId: 'q1',
      offerType: 'vto',
      employeeId: 'e2',
      status: 'offered',
    });
    expect(nats.publish).toHaveBeenCalledWith(
      INTRADAY_SUBJECTS.STAFFING_OFFER_CREATED,
      expect.objectContaining({ tenantId: 't1', queueId: 'q1', offerType: 'vto', employeeId: 'e1' }),
    );
  });

  it('offers overtime to every tracked queue member when deficit exceeds the threshold', async () => {
    const { service, repository } = makeService({ queueMembers: ['e1'] });

    await service.evaluateQueueMetrics('t1', 'q1', { ...baseRecord, serviceLevelCurrent: 0.6 }); // 20pp deficit

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save.mock.calls[0][0]).toMatchObject({ offerType: 'overtime', employeeId: 'e1' });
  });

  it('does nothing when the breaching/surplus queue has no tracked members (never fabricates an offer)', async () => {
    const { service, repository } = makeService({ queueMembers: [] });

    await service.evaluateQueueMetrics('t1', 'q1', { ...baseRecord, serviceLevelCurrent: 0.95 });

    expect(repository.findOne).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('the repeat-guard skips an employee who already has an offer of the same type for this queue', async () => {
    const repository = makeRepository({ e1: { id: 'existing' } });
    const { service } = makeService({ queueMembers: ['e1', 'e2'], repository });

    await service.evaluateQueueMetrics('t1', 'q1', { ...baseRecord, serviceLevelCurrent: 0.95 });

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save.mock.calls[0][0].employeeId).toBe('e2');
  });

  it('a NATS publish failure is logged, not thrown', async () => {
    const { service } = makeService({
      queueMembers: ['e1'],
      natsPublish: jest.fn().mockRejectedValue(new Error('nats down')),
    });

    await expect(
      service.evaluateQueueMetrics('t1', 'q1', { ...baseRecord, serviceLevelCurrent: 0.95 }),
    ).resolves.toBeUndefined();
  });
});
