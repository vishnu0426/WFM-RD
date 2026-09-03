import { SchedulePublishedConsumerService } from '../../src/consumers/schedule-published.consumer';

describe('SchedulePublishedConsumerService.handlePayload', () => {
  const makeRedis = () => ({ trackEmployeeForScheduleSync: jest.fn().mockResolvedValue(undefined) });
  const makeScheduledActivity = () => ({ refresh: jest.fn().mockResolvedValue(undefined) });
  const makeConfig = (ttl = 172800) => ({ get: jest.fn().mockReturnValue(ttl) });

  it('tracks and immediately refreshes every employeeId named in the payload', async () => {
    const redis = makeRedis();
    const scheduledActivity = makeScheduledActivity();
    const consumer = new SchedulePublishedConsumerService(
      undefined as never,
      redis as never,
      scheduledActivity as never,
      makeConfig(3600) as never,
    );

    await consumer.handlePayload({
      tenantId: 't1',
      scheduleId: 'sched-1',
      orgUnitId: 'org-1',
      publishedAt: '2026-08-07T09:00:00.000Z',
      employeeIds: ['e1', 'e2'],
    });

    expect(redis.trackEmployeeForScheduleSync).toHaveBeenCalledWith('t1', 'e1', 3600);
    expect(redis.trackEmployeeForScheduleSync).toHaveBeenCalledWith('t1', 'e2', 3600);
    expect(scheduledActivity.refresh).toHaveBeenCalledWith('t1', 'e1');
    expect(scheduledActivity.refresh).toHaveBeenCalledWith('t1', 'e2');
  });

  it('does nothing for an empty employeeIds list', async () => {
    const redis = makeRedis();
    const scheduledActivity = makeScheduledActivity();
    const consumer = new SchedulePublishedConsumerService(
      undefined as never,
      redis as never,
      scheduledActivity as never,
      makeConfig() as never,
    );

    await consumer.handlePayload({
      tenantId: 't1',
      scheduleId: 'sched-1',
      orgUnitId: 'org-1',
      publishedAt: '2026-08-07T09:00:00.000Z',
      employeeIds: [],
    });

    expect(redis.trackEmployeeForScheduleSync).not.toHaveBeenCalled();
    expect(scheduledActivity.refresh).not.toHaveBeenCalled();
  });
});
