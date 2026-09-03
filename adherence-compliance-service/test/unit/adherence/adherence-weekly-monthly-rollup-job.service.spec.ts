import { AdherenceWeeklyMonthlyRollupJobService } from '../../../src/adherence/adherence-weekly-monthly-rollup-job.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { TimezoneResolverService } from '../../../src/adherence/timezone-resolver.service';

/**
 * Constructed directly, same reasoning as
 * `adherence-daily-rollup-job.service.spec.ts`'s own doc comment.
 * Regression coverage for a real bug caught during design, not by running
 * the query: a naive `now - trailingDays` cutoff can land mid-week or
 * mid-month, which would aggregate that boundary period from only *some*
 * of its constituent `'day'` rows - wrong, not just "not yet computed."
 */
describe('AdherenceWeeklyMonthlyRollupJobService', () => {
  let service: AdherenceWeeklyMonthlyRollupJobService;
  let pool: { query: jest.Mock };
  let resolveTimezones: jest.Mock;

  function buildService(config: Record<string, number> = {}): AdherenceWeeklyMonthlyRollupJobService {
    pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    resolveTimezones = jest.fn().mockResolvedValue(new Map());
    const stubConfig = { get: (key: string) => config[key] } as any;
    const stubMetrics = { recordRollupJobRun: jest.fn(), observeRollupJobLag: jest.fn() } as unknown as MetricsService;
    const stubTimezoneResolver = { resolveTimezones } as unknown as TimezoneResolverService;
    return new AdherenceWeeklyMonthlyRollupJobService(pool as any, stubConfig, stubMetrics, stubTimezoneResolver);
  }

  beforeEach(() => {
    service = buildService();
  });

  it("rounds the window start back to the Monday on-or-before the containing month's start, with one extra day of safety margin", async () => {
    // 2026-08-11 minus the 35-day default lands on 2026-07-07 (a Tuesday) -
    // naively using that directly would silently drop 2026-07-01..07-06 out
    // of July's own aggregation. 2026-07-01 is a Wednesday (ISO weekday 3),
    // so the month-start floor is Monday 2026-06-29 - one extra day back
    // (2026-06-28) accounts for ADR-0099's per-employee timezone offset
    // margin.
    const now = new Date('2026-08-11T00:00:00Z');

    await service.rollupTrailingWindow(now);

    expect(pool.query).toHaveBeenCalledTimes(1); // only the distinct-employees discovery query - no employees found
    const [, params] = pool.query.mock.calls[0];
    const [windowStart, windowEnd] = params;
    expect(windowStart.toISOString()).toBe('2026-06-28T00:00:00.000Z');
    expect(windowEnd.toISOString()).toBe('2026-08-12T00:00:00.000Z');
  });

  it('handles a month whose 1st already falls on a Monday (no rounding needed beyond the safety margin)', async () => {
    // now - 35 days from 2026-09-05 lands 2026-08-01, itself a Saturday -
    // the containing month (August 2026) starts 2026-08-01, a Saturday
    // (ISO weekday 6), so the floor is Monday 2026-07-27, minus one more
    // day of margin.
    const now = new Date('2026-09-05T00:00:00Z');
    await service.rollupTrailingWindow(now);
    const [, params] = pool.query.mock.calls[0];
    expect(params[0].toISOString()).toBe('2026-07-26T00:00:00.000Z');
  });

  it('groups employees by resolved timezone per tenant and runs both the week and month rollup query for each group', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ tenant_id: 't1', employee_id: 'e1' }] });
    resolveTimezones.mockResolvedValueOnce(new Map([['e1', 'America/New_York']]));
    pool.query.mockResolvedValue(undefined);

    await service.rollupTrailingWindow(new Date('2026-01-15T00:00:00Z'));

    // 1 discovery query + 1 week query + 1 month query for the single group.
    expect(pool.query).toHaveBeenCalledTimes(3);
    const [weekSql, weekParams] = pool.query.mock.calls[1];
    const [monthSql, monthParams] = pool.query.mock.calls[2];
    expect(weekSql).toContain("'week'");
    expect(monthSql).toContain("'month'");
    expect(weekParams).toEqual(['t1', ['e1'], 'America/New_York', expect.any(Date), expect.any(Date)]);
    expect(monthParams).toEqual(weekParams);
  });
});
