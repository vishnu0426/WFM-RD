import { AssignmentChangedConsumerService } from '../../src/consumers/assignment-changed.consumer';

describe('AssignmentChangedConsumerService.handlePayload', () => {
  it('tracks and immediately refreshes the affected employee (mid-shift override, §2.2 rule 2)', async () => {
    const redis = { trackEmployeeForScheduleSync: jest.fn().mockResolvedValue(undefined) };
    const scheduledActivity = { refresh: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn().mockReturnValue(172800) };
    const consumer = new AssignmentChangedConsumerService(
      undefined as never,
      redis as never,
      scheduledActivity as never,
      config as never,
    );

    await consumer.handlePayload({
      tenantId: 't1',
      scheduleId: 'sched-1',
      assignmentId: 'assign-1',
      employeeId: 'e2',
      shiftStart: '2026-08-07T09:00:00.000Z',
      shiftEnd: '2026-08-07T17:00:00.000Z',
      reason: 'manual_override',
    });

    expect(redis.trackEmployeeForScheduleSync).toHaveBeenCalledWith('t1', 'e2', 172800);
    expect(scheduledActivity.refresh).toHaveBeenCalledWith('t1', 'e2');
  });
});
