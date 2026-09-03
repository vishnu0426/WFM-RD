import { AdherenceRollupSchedulerService } from '../../src/adherence/adherence-rollup-scheduler.service';
import { ON_SHIFT_ACTIVITY } from '../../src/schedule/scheduled-activity.service';

describe('AdherenceRollupSchedulerService.tick', () => {
  it('upserts both the hourly and daily rollup tables, using the on_shift sentinel as a query param', async () => {
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const scheduler = new AdherenceRollupSchedulerService(pool as never);

    await scheduler.tick();

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [hourlySql, hourlyParams] = pool.query.mock.calls[0];
    const [dailySql, dailyParams] = pool.query.mock.calls[1];
    expect(hourlySql).toContain('adherence_hourly_rollup');
    expect(dailySql).toContain('adherence_daily_rollup');
    expect((hourlyParams as unknown[])[1]).toBe(ON_SHIFT_ACTIVITY);
    expect((dailyParams as unknown[])[1]).toBe(ON_SHIFT_ACTIVITY);
  });

  it('a failed tick logs and does not throw', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    const scheduler = new AdherenceRollupSchedulerService(pool as never);

    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it('a concurrent tick while one is already running is a no-op (re-entrancy guard)', async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const pool = { query: jest.fn().mockImplementation(async () => gate) };
    const scheduler = new AdherenceRollupSchedulerService(pool as never);

    const first = scheduler.tick();
    const second = scheduler.tick();
    resolveFirst?.();
    await Promise.all([first, second]);

    // First tick makes 2 calls (hourly + daily upsert); the second tick's
    // guard blocks it from making any at all.
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
