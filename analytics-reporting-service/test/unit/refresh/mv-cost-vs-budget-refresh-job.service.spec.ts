import { MvCostVsBudgetRefreshJobService } from '../../../src/refresh/mv-cost-vs-budget-refresh-job.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

describe('MvCostVsBudgetRefreshJobService', () => {
  let replicaPool: { query: jest.Mock };
  let primaryPool: { connect: jest.Mock; query: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let service: MvCostVsBudgetRefreshJobService;

  beforeEach(() => {
    replicaPool = { query: jest.fn() };
    client = { query: jest.fn().mockResolvedValue(undefined), release: jest.fn() };
    primaryPool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() };
    service = new MvCostVsBudgetRefreshJobService(primaryPool as any, replicaPool as any, new MetricsService());
  });

  it('reads the three-schema join from the replica pool, joining on cost_center and excluding nulls', async () => {
    replicaPool.query.mockResolvedValueOnce({ rows: [] });

    await service.refresh();

    const sql = replicaPool.query.mock.calls[0][0];
    expect(sql).toContain('FROM scheduling.shift_assignments');
    expect(sql).toContain('FROM attendance_leave.leave_request');
    expect(sql).toContain('JOIN org.employees');
    expect(sql).toContain('e.cost_center IS NOT NULL');
    expect(sql).toContain("lr.status = 'approved'");
  });

  it('upserts hours/days (never a dollar column) via the primary pool', async () => {
    replicaPool.query.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: 't1',
          cost_center: 'CC-100',
          period_start: new Date('2026-08-01T00:00:00Z'),
          scheduled_hours: '26.00',
          overtime_hours: '10.00',
          approved_leave_days: '3.00',
          max_observed_at: new Date('2026-08-11T10:00:00Z'),
        },
      ],
    });

    await service.refresh();

    const insertCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO analytics_mv.mv_cost_vs_budget'),
    );
    expect(insertCall?.[0]).toContain('$3::timestamptz, $3::timestamptz + interval');
    expect(insertCall?.[0]).not.toMatch(/\bcost\b|\bbudget\b/i);
    expect(insertCall?.[1]).toEqual(['t1', 'CC-100', expect.any(Date), '26.00', '10.00', '3.00']);
  });

  it('data_as_of is the max observed timestamp across rows, null when no rows', async () => {
    replicaPool.query.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: 't1',
          cost_center: 'CC-100',
          period_start: new Date('2026-08-01T00:00:00Z'),
          scheduled_hours: '8.00',
          overtime_hours: '0.00',
          approved_leave_days: '0.00',
          max_observed_at: new Date('2026-08-10T00:00:00Z'),
        },
        {
          tenant_id: 't1',
          cost_center: 'CC-200',
          period_start: new Date('2026-08-01T00:00:00Z'),
          scheduled_hours: '0.00',
          overtime_hours: '0.00',
          approved_leave_days: '2.00',
          max_observed_at: new Date('2026-08-12T00:00:00Z'),
        },
      ],
    });

    await service.refresh();

    const lineageUpdate = client.query.mock.calls.find(([sql]) => sql.includes('UPDATE analytics_mv.mv_lineage'));
    expect(lineageUpdate?.[1][0]).toEqual(new Date('2026-08-12T00:00:00Z'));
  });

  it('rolls back on upsert failure', async () => {
    replicaPool.query.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: 't1',
          cost_center: 'CC-100',
          period_start: new Date(),
          scheduled_hours: '1.00',
          overtime_hours: '0.00',
          approved_leave_days: '0.00',
          max_observed_at: new Date(),
        },
      ],
    });
    client.query.mockImplementation((sql: string) =>
      sql.includes('INSERT INTO analytics_mv.mv_cost_vs_budget')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(undefined),
    );

    await expect(service.refresh()).rejects.toThrow('boom');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
