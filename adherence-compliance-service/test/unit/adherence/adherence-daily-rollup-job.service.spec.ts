import { AdherenceDailyRollupJobService } from '../../../src/adherence/adherence-daily-rollup-job.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { TimezoneResolverService } from '../../../src/adherence/timezone-resolver.service';

/**
 * Constructed directly (`new AdherenceDailyRollupJobService(...)`), not via
 * `Test.createTestingModule` - this service now depends on
 * `TimezoneResolverService` (ADR-0099), which itself depends on two gRPC
 * clients; a direct construction with a hand-rolled stub keeps this test
 * about the job's own query/grouping logic, not about wiring a gRPC
 * `ClientsModule` just to satisfy DI.
 */
describe('AdherenceDailyRollupJobService', () => {
  let service: AdherenceDailyRollupJobService;
  let pool: { query: jest.Mock };
  let resolveTimezones: jest.Mock;

  function buildService(config: Record<string, number> = {}): AdherenceDailyRollupJobService {
    pool = { query: jest.fn() };
    resolveTimezones = jest.fn();
    const stubConfig = { get: (key: string) => config[key] } as any;
    const stubMetrics = { recordRollupJobRun: jest.fn(), observeRollupJobLag: jest.fn() } as unknown as MetricsService;
    const stubTimezoneResolver = { resolveTimezones } as unknown as TimezoneResolverService;
    return new AdherenceDailyRollupJobService(pool as any, stubConfig, stubMetrics, stubTimezoneResolver);
  }

  beforeEach(() => {
    service = buildService();
  });

  it('queries for distinct active employees using a scan window padded a day on each side of the trailing range', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const now = new Date('2026-08-11T14:23:00Z');

    await service.rollupTrailingWindow(now);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('SELECT DISTINCT tenant_id, employee_id');
    // Default trailing window is 2 days - padded one extra day on each side.
    expect(params[0].toISOString()).toBe('2026-08-08T14:23:00.000Z');
    expect(params[1].toISOString()).toBe('2026-08-12T14:23:00.000Z');
  });

  it('groups employees by resolved timezone within each tenant, and runs one rollup query per (tenant, timezone) group', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { tenant_id: 't1', employee_id: 'e1' },
        { tenant_id: 't1', employee_id: 'e2' },
      ],
    });
    resolveTimezones.mockResolvedValueOnce(
      new Map([
        ['e1', 'America/New_York'],
        ['e2', 'Asia/Kolkata'],
      ]),
    );
    pool.query.mockResolvedValue(undefined);

    await service.rollupTrailingWindow(new Date('2026-08-11T00:00:00Z'));

    expect(resolveTimezones).toHaveBeenCalledWith('t1', ['e1', 'e2']);
    // 1 discovery query + 2 per-timezone rollup queries.
    expect(pool.query).toHaveBeenCalledTimes(3);
    const groupCalls = pool.query.mock.calls.slice(1);
    const byTimezone = new Map(groupCalls.map(([, params]) => [params[2], params]));
    expect(byTimezone.get('America/New_York')).toEqual([
      't1',
      ['e1'],
      'America/New_York',
      expect.any(Date),
      expect.any(Date),
      300,
    ]);
    expect(byTimezone.get('Asia/Kolkata')).toEqual([
      't1',
      ['e2'],
      'Asia/Kolkata',
      expect.any(Date),
      expect.any(Date),
      300,
    ]);
  });

  it('resolves timezones independently per tenant, never mixing employee ids across tenants', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { tenant_id: 't1', employee_id: 'e1' },
        { tenant_id: 't2', employee_id: 'e2' },
      ],
    });
    resolveTimezones.mockResolvedValue(new Map());
    pool.query.mockResolvedValue(undefined);

    await service.rollupTrailingWindow(new Date('2026-08-11T00:00:00Z'));

    expect(resolveTimezones).toHaveBeenCalledTimes(2);
    expect(resolveTimezones).toHaveBeenCalledWith('t1', ['e1']);
    expect(resolveTimezones).toHaveBeenCalledWith('t2', ['e2']);
  });

  it('uses the configured major-deviation threshold as the sixth query parameter of each group query', async () => {
    service = buildService({ ADHERENCE_MAJOR_DEVIATION_THRESHOLD_SECONDS: 600 });
    pool.query.mockResolvedValueOnce({ rows: [{ tenant_id: 't1', employee_id: 'e1' }] });
    resolveTimezones.mockResolvedValueOnce(new Map([['e1', 'UTC']]));
    pool.query.mockResolvedValue(undefined);

    await service.rollupTrailingWindow(new Date('2026-08-11T00:00:00Z'));

    expect(pool.query.mock.calls[1][1][5]).toBe(600);
  });

  it('a re-entrant tick() while one is already running returns immediately, without querying at all', async () => {
    let resolveFirst!: () => void;
    pool.query.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = () => resolve({ rows: [] }))));
    const first = service.tick();
    const second = service.tick();
    resolveFirst();
    await Promise.all([first, second]);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
