import { Pool } from 'pg';
import { LeaveCarryoverJobService } from '../../../../src/leave/carryover/leave-carryover-job.service';
import { MetricsService } from '../../../../src/common/metrics/metrics.service';

describe('LeaveCarryoverJobService', () => {
  let pool: { query: jest.Mock };
  let metrics: MetricsService;
  let service: LeaveCarryoverJobService;

  beforeEach(() => {
    pool = { query: jest.fn() };
    metrics = new MetricsService();
    jest.spyOn(metrics, 'recordCarryoverRolloverRun');
    jest.spyOn(metrics, 'recordCarryoverExpiryRun');
    service = new LeaveCarryoverJobService(pool as unknown as Pool, metrics);
  });

  it('runs the rollover UPDATE then the expiry UPDATE, in that order, in one tick', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 } as never);

    await service.tick();

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [rolloverSql] = pool.query.mock.calls[0];
    const [expirySql] = pool.query.mock.calls[1];
    expect(rolloverSql).toContain('carryover_applied = true');
    expect(rolloverSql).toContain('carryover_applied = false');
    expect(expirySql).toContain('carryover_expiry_date < CURRENT_DATE');
  });

  it('records the balances-rolled-over count and days-rolled-over sum from RETURNING rows on success', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ amount: '3.00' }, { amount: '0.00' }], rowCount: 2 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await service.tick();

    expect(metrics.recordCarryoverRolloverRun).toHaveBeenCalledWith('success', 2, 3);
  });

  it('records the balances-expired count and days-expired sum from RETURNING rows on success', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ clawback: '2.50' }], rowCount: 1 } as never);

    await service.tick();

    expect(metrics.recordCarryoverExpiryRun).toHaveBeenCalledWith('success', 1, 2.5);
  });

  it('a failed rollover query logs and records an error result, but still runs the expiry query', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await expect(service.tick()).resolves.toBeUndefined();

    expect(metrics.recordCarryoverRolloverRun).toHaveBeenCalledWith('error');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('a failed expiry query logs and records an error result without throwing', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never).mockRejectedValueOnce(new Error('db down'));

    await expect(service.tick()).resolves.toBeUndefined();

    expect(metrics.recordCarryoverExpiryRun).toHaveBeenCalledWith('error');
  });

  it('a concurrent tick while one is already running is a no-op (re-entrancy guard)', async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise((resolve) => {
      resolveFirst = resolve as () => void;
    });
    pool.query.mockImplementation(async () => {
      await gate;
      return { rows: [], rowCount: 0 } as never;
    });

    const first = service.tick();
    const second = service.tick();
    resolveFirst?.();
    await Promise.all([first, second]);

    // First tick makes 2 calls (rollover + expiry); the second tick's
    // guard blocks it from making any at all.
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
