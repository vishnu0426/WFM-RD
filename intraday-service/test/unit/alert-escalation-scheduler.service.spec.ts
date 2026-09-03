import { AlertEscalationSchedulerService } from '../../src/alerting/alert-escalation-scheduler.service';
import { alertRaisedTrigger } from '../../src/graphql/subscription-triggers';

describe('AlertEscalationSchedulerService.tick', () => {
  const row = {
    id: 'a1',
    tenant_id: 't1',
    alert_type: 'service_level_breach',
    org_unit_id: null,
    queue_id: 'q1',
    dedup_group_id: 'g1',
    created_at: new Date('2026-08-07T09:00:00.000Z'),
    last_triggered_at: new Date('2026-08-07T09:00:00.000Z'),
  };

  it('escalates each stale warning row to critical and re-publishes alertRaised', async () => {
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({}),
    };
    const pubSub = { publish: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new AlertEscalationSchedulerService(pool as never, pubSub as never);

    await scheduler.tick();

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = pool.query.mock.calls[1];
    expect(updateSql).toContain("severity = 'critical'");
    expect((updateParams as unknown[])[0]).toBe('a1');
    expect(pubSub.publish).toHaveBeenCalledWith(
      alertRaisedTrigger('t1'),
      expect.objectContaining({ alertRaised: expect.objectContaining({ id: 'a1', severity: 'critical' }) }),
    );
  });

  it('no stale rows: queries once, updates and publishes nothing', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const pubSub = { publish: jest.fn() };
    const scheduler = new AlertEscalationSchedulerService(pool as never, pubSub as never);

    await scheduler.tick();

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pubSub.publish).not.toHaveBeenCalled();
  });

  it('a failed tick logs and does not throw', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    const pubSub = { publish: jest.fn() };
    const scheduler = new AlertEscalationSchedulerService(pool as never, pubSub as never);

    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it('a concurrent tick while one is already running is a no-op (re-entrancy guard)', async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<{ rows: unknown[] }>((resolve) => {
      resolveFirst = () => resolve({ rows: [] });
    });
    const pool = { query: jest.fn().mockImplementation(async () => gate) };
    const pubSub = { publish: jest.fn() };
    const scheduler = new AlertEscalationSchedulerService(pool as never, pubSub as never);

    const first = scheduler.tick();
    const second = scheduler.tick();
    resolveFirst?.();
    await Promise.all([first, second]);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
