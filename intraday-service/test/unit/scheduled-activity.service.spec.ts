import { ON_SHIFT_ACTIVITY, ScheduledActivityService } from '../../src/schedule/scheduled-activity.service';

describe('ScheduledActivityService.refresh', () => {
  const makeClient = (assignments: unknown[]) => ({ getShiftAssignments: jest.fn().mockResolvedValue(assignments) });
  const makeRedis = () => ({ writeAgentLiveState: jest.fn().mockResolvedValue(undefined) });

  it('sets scheduledActivity to "on_shift" when the endpoint returns a covering assignment', async () => {
    const client = makeClient([{ id: 'a1' }]);
    const redis = makeRedis();
    const service = new ScheduledActivityService(client as never, redis as never);

    await service.refresh('t1', 'e1');

    expect(redis.writeAgentLiveState).toHaveBeenCalledWith('t1', 'e1', { scheduledActivity: ON_SHIFT_ACTIVITY });
  });

  it('sets scheduledActivity to null when no assignment covers now', async () => {
    const client = makeClient([]);
    const redis = makeRedis();
    const service = new ScheduledActivityService(client as never, redis as never);

    await service.refresh('t1', 'e1');

    expect(redis.writeAgentLiveState).toHaveBeenCalledWith('t1', 'e1', { scheduledActivity: null });
  });

  it('queries a zero-width window at "now" (windowStart equals windowEnd) - no arbitrary lookahead padding', async () => {
    const client = makeClient([]);
    const redis = makeRedis();
    const service = new ScheduledActivityService(client as never, redis as never);

    await service.refresh('t1', 'e1');

    const [tenantId, employeeId, windowStart, windowEnd] = client.getShiftAssignments.mock.calls[0] as [
      string,
      string,
      Date,
      Date,
    ];
    expect(tenantId).toBe('t1');
    expect(employeeId).toBe('e1');
    expect(windowStart.getTime()).toBe(windowEnd.getTime());
  });
});
