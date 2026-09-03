import { ShiftStartPreloadSchedulerService } from '../../src/schedule/shift-start-preload-scheduler.service';

describe('ShiftStartPreloadSchedulerService.tick', () => {
  it('refreshes every tracked employee', async () => {
    const redis = {
      listTrackedEmployees: jest.fn().mockResolvedValue([
        { tenantId: 't1', employeeId: 'e1' },
        { tenantId: 't1', employeeId: 'e2' },
      ]),
    };
    const scheduledActivity = { refresh: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new ShiftStartPreloadSchedulerService(redis as never, scheduledActivity as never);

    await scheduler.tick();

    expect(scheduledActivity.refresh).toHaveBeenCalledWith('t1', 'e1');
    expect(scheduledActivity.refresh).toHaveBeenCalledWith('t1', 'e2');
  });

  it('one employee failing does not block the rest of the tick (per-entity isolation, mirrors SkillDecaySchedulerService)', async () => {
    const redis = {
      listTrackedEmployees: jest.fn().mockResolvedValue([
        { tenantId: 't1', employeeId: 'e1' },
        { tenantId: 't1', employeeId: 'e2' },
      ]),
    };
    const scheduledActivity = {
      refresh: jest.fn().mockImplementation(async (_tenantId: string, employeeId: string) => {
        if (employeeId === 'e1') {
          throw new Error('scheduling-service unavailable');
        }
      }),
    };
    const scheduler = new ShiftStartPreloadSchedulerService(redis as never, scheduledActivity as never);

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(scheduledActivity.refresh).toHaveBeenCalledWith('t1', 'e2');
  });

  it('a concurrent tick while one is already running is a no-op (re-entrancy guard)', async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const redis = {
      listTrackedEmployees: jest.fn().mockImplementation(async () => {
        await gate;
        return [];
      }),
    };
    const scheduledActivity = { refresh: jest.fn() };
    const scheduler = new ShiftStartPreloadSchedulerService(redis as never, scheduledActivity as never);

    const firstTick = scheduler.tick();
    const secondTick = scheduler.tick();
    resolveFirst?.();
    await Promise.all([firstTick, secondTick]);

    expect(redis.listTrackedEmployees).toHaveBeenCalledTimes(1);
  });
});
