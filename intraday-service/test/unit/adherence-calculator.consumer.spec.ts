import { AdherenceCalculatorConsumerService } from '../../src/adherence/adherence-calculator.consumer';
import { AgentStateChangedPayload } from '../../src/nats/subjects';

describe('AdherenceCalculatorConsumerService.handlePayload', () => {
  const payload: AgentStateChangedPayload = {
    tenantId: 't1',
    employeeId: 'e1',
    sourceEventId: 'evt-1',
    currentActivity: 'on_call',
    activityStartedAt: '2026-08-07T10:00:00.000Z',
    siteId: null,
    queueId: null,
    receivedAt: '2026-08-07T10:00:00.000Z',
  };

  const makeManager = (previousEvent: unknown) => {
    const repository = {
      findOne: jest.fn().mockResolvedValue(previousEvent),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    return {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(repository),
      repository,
    };
  };

  const makeDataSource = (manager: ReturnType<typeof makeManager>) => ({
    transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
  });

  it('inserts a first-ever event with fromActivity null and deviationSeconds 0', async () => {
    const manager = makeManager(null);
    const redis = { readAgentLiveState: jest.fn().mockResolvedValue({ scheduledActivity: 'on_shift' }) };
    const service = new AdherenceCalculatorConsumerService(
      undefined as never,
      redis as never,
      makeDataSource(manager) as never,
    );

    await service.handlePayload(payload);

    expect(manager.repository.insert).toHaveBeenCalledTimes(1);
    const inserted = manager.repository.insert.mock.calls[0][0];
    expect(inserted).toMatchObject({
      tenantId: 't1',
      employeeId: 'e1',
      eventType: 'activity_changed',
      fromActivity: null,
      toActivity: 'on_call',
      scheduledActivity: 'on_shift',
      deviationSeconds: 0,
    });
  });

  it("carries the previous event's toActivity forward as this event's fromActivity", async () => {
    const previous = {
      toActivity: 'break',
      scheduledActivity: 'on_shift',
      timestamp: new Date('2026-08-07T09:55:00.000Z'),
    };
    const manager = makeManager(previous);
    const redis = { readAgentLiveState: jest.fn().mockResolvedValue({ scheduledActivity: 'on_shift' }) };
    const service = new AdherenceCalculatorConsumerService(
      undefined as never,
      redis as never,
      makeDataSource(manager) as never,
    );

    await service.handlePayload(payload);

    expect(manager.repository.insert.mock.calls[0][0].fromActivity).toBe('break');
  });

  it('computes a nonzero deviationSeconds when the previous segment was non-adherent', async () => {
    const previous = {
      toActivity: 'available',
      scheduledActivity: null,
      timestamp: new Date('2026-08-07T09:55:00.000Z'),
    };
    const manager = makeManager(previous);
    const redis = { readAgentLiveState: jest.fn().mockResolvedValue({ scheduledActivity: 'on_shift' }) };
    const service = new AdherenceCalculatorConsumerService(
      undefined as never,
      redis as never,
      makeDataSource(manager) as never,
    );

    // payload.receivedAt is 10:00:00, previous.timestamp is 09:55:00 -> 300s.
    await service.handlePayload(payload);

    expect(manager.repository.insert.mock.calls[0][0].deviationSeconds).toBe(300);
  });

  it('treats no Redis record as scheduledActivity null, never throws', async () => {
    const manager = makeManager(null);
    const redis = { readAgentLiveState: jest.fn().mockResolvedValue(null) };
    const service = new AdherenceCalculatorConsumerService(
      undefined as never,
      redis as never,
      makeDataSource(manager) as never,
    );

    await service.handlePayload(payload);

    expect(manager.repository.insert.mock.calls[0][0].scheduledActivity).toBeNull();
  });

  it('scopes the transaction via SET LOCAL app.current_tenant_id (withTenantConnection, ADR-0002/0066)', async () => {
    const manager = makeManager(null);
    const redis = { readAgentLiveState: jest.fn().mockResolvedValue(null) };
    const service = new AdherenceCalculatorConsumerService(
      undefined as never,
      redis as never,
      makeDataSource(manager) as never,
    );

    await service.handlePayload(payload);

    expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['app.current_tenant_id', 't1']);
  });

  it('also writes an AdherenceException row when the completed segment was non-adherent', async () => {
    const previous = {
      toActivity: 'available',
      scheduledActivity: null,
      timestamp: new Date('2026-08-07T09:55:00.000Z'),
    };
    const manager = makeManager(previous);
    const redis = { readAgentLiveState: jest.fn().mockResolvedValue({ scheduledActivity: 'on_shift' }) };
    const service = new AdherenceCalculatorConsumerService(
      undefined as never,
      redis as never,
      makeDataSource(manager) as never,
    );

    await service.handlePayload(payload);

    expect(manager.repository.insert).toHaveBeenCalledTimes(2);
    const exception = manager.repository.insert.mock.calls[1][0];
    expect(exception).toMatchObject({
      tenantId: 't1',
      employeeId: 'e1',
      activity: 'available',
      scheduledActivity: null,
      startedAt: previous.timestamp,
      endedAt: new Date(payload.receivedAt),
      deviationSeconds: 300,
      status: 'open',
    });
  });

  it('does not write an AdherenceException row when the completed segment was adherent (deviationSeconds 0)', async () => {
    const previous = {
      toActivity: 'break',
      scheduledActivity: 'on_shift',
      timestamp: new Date('2026-08-07T09:55:00.000Z'),
    };
    const manager = makeManager(previous);
    const redis = { readAgentLiveState: jest.fn().mockResolvedValue({ scheduledActivity: 'on_shift' }) };
    const service = new AdherenceCalculatorConsumerService(
      undefined as never,
      redis as never,
      makeDataSource(manager) as never,
    );

    await service.handlePayload(payload);

    expect(manager.repository.insert).toHaveBeenCalledTimes(1);
  });

  it('does not write an AdherenceException row for a first-ever event (no previous segment to have deviated in)', async () => {
    const manager = makeManager(null);
    const redis = { readAgentLiveState: jest.fn().mockResolvedValue({ scheduledActivity: 'on_shift' }) };
    const service = new AdherenceCalculatorConsumerService(
      undefined as never,
      redis as never,
      makeDataSource(manager) as never,
    );

    await service.handlePayload(payload);

    expect(manager.repository.insert).toHaveBeenCalledTimes(1);
  });
});
