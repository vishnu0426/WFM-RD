import { QueueMetricsSnapshotRetentionSchedulerService } from '../../src/live-state/queue-metrics-snapshot-retention-scheduler.service';

describe('QueueMetricsSnapshotRetentionSchedulerService.tick', () => {
  it('deletes snapshot rows older than the retention window', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 3 }) };
    const scheduler = new QueueMetricsSnapshotRetentionSchedulerService(pool as never);

    await scheduler.tick();

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM intraday.queue_metrics_snapshot');
    expect(params).toEqual([7]);
  });

  it('a failed tick logs and does not throw', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    const scheduler = new QueueMetricsSnapshotRetentionSchedulerService(pool as never);

    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it('a concurrent tick while one is already running is a no-op (re-entrancy guard)', async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<{ rowCount: number }>((resolve) => {
      resolveFirst = () => resolve({ rowCount: 0 });
    });
    const pool = { query: jest.fn().mockImplementation(async () => gate) };
    const scheduler = new QueueMetricsSnapshotRetentionSchedulerService(pool as never);

    const first = scheduler.tick();
    const second = scheduler.tick();
    resolveFirst?.();
    await Promise.all([first, second]);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
