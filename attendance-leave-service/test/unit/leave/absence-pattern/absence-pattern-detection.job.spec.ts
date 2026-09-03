import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AbsencePatternDetectionJob } from '../../../../src/leave/absence-pattern/absence-pattern-detection.job';
import { CalendarGrpcClientService } from '../../../../src/grpc/calendar-grpc-client.service';
import { MetricsService } from '../../../../src/common/metrics/metrics.service';

describe('AbsencePatternDetectionJob', () => {
  let pool: { query: jest.Mock };
  let calendarClient: { getWorkingTimeRules: jest.Mock };
  let metrics: MetricsService;
  let service: AbsencePatternDetectionJob;

  beforeEach(() => {
    pool = { query: jest.fn() };
    calendarClient = { getWorkingTimeRules: jest.fn() };
    metrics = new MetricsService();
    jest.spyOn(metrics, 'recordAbsencePatternDetectionRun');
    const config = new ConfigService({});
    service = new AbsencePatternDetectionJob(
      pool as unknown as Pool,
      config,
      calendarClient as unknown as CalendarGrpcClientService,
      metrics,
    );
  });

  function mockNoTenants(): void {
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // frequency
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // recurring
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // tenant list (empty)
  }

  it('runs frequency, then recurring, then the holiday tenant-list query, in that order', async () => {
    mockNoTenants();

    await service.tick();

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query.mock.calls[0][0]).toContain("'frequency_threshold'");
    expect(pool.query.mock.calls[1][0]).toContain("'recurring_day_of_week'");
    expect(pool.query.mock.calls[2][0]).toContain('SELECT DISTINCT tenant_id');
  });

  it('records success with the row count for the frequency step', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ employee_id: 'e1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await service.tick();

    expect(metrics.recordAbsencePatternDetectionRun).toHaveBeenCalledWith('frequency_threshold', 'success', 1);
  });

  it('a failed frequency query is logged and does not block the recurring or holiday steps', async () => {
    pool.query
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await expect(service.tick()).resolves.toBeUndefined();

    expect(metrics.recordAbsencePatternDetectionRun).toHaveBeenCalledWith('frequency_threshold', 'error');
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it("holiday step: calls the calendar client per tenant and inserts using that tenant's holiday dates", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // frequency
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // recurring
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1' }], rowCount: 1 } as never) // tenant list
      .mockResolvedValueOnce({ rows: [{ employee_id: 'e1' }], rowCount: 1 } as never); // per-tenant insert
    calendarClient.getWorkingTimeRules.mockResolvedValue({
      countryCode: 'US',
      timezone: 'UTC',
      holidayDates: ['2026-07-04'],
      standardBusinessHoursJson: '{}',
    });

    await service.tick();

    expect(calendarClient.getWorkingTimeRules).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', orgUnitId: '' }),
    );
    const [insertSql, params] = pool.query.mock.calls[3];
    expect(insertSql).toContain("'pre_post_holiday'");
    expect(params).toEqual(['tenant-1', expect.any(Number), expect.any(Number), ['2026-07-04']]);
    expect(metrics.recordAbsencePatternDetectionRun).toHaveBeenCalledWith('pre_post_holiday', 'success', 1);
  });

  it('holiday step: skips a tenant with no configured holidays, without an extra INSERT query', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1' }], rowCount: 1 } as never);
    calendarClient.getWorkingTimeRules.mockResolvedValue({
      countryCode: '',
      timezone: 'UTC',
      holidayDates: [],
      standardBusinessHoursJson: '{}',
    });

    await service.tick();

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(metrics.recordAbsencePatternDetectionRun).toHaveBeenCalledWith('pre_post_holiday', 'success', 0);
  });

  it('holiday step: a gRPC failure for one tenant is logged and does not stop other tenants from being processed', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1' }, { tenant_id: 'tenant-2' }], rowCount: 2 } as never)
      .mockResolvedValueOnce({ rows: [{ employee_id: 'e2' }], rowCount: 1 } as never); // tenant-2's insert
    calendarClient.getWorkingTimeRules
      .mockRejectedValueOnce(new Error('core unreachable')) // tenant-1
      .mockResolvedValueOnce({
        countryCode: 'US',
        timezone: 'UTC',
        holidayDates: ['2026-12-25'],
        standardBusinessHoursJson: '{}',
      }); // tenant-2

    await service.tick();

    expect(calendarClient.getWorkingTimeRules).toHaveBeenCalledTimes(2);
    expect(metrics.recordAbsencePatternDetectionRun).toHaveBeenCalledWith('pre_post_holiday', 'error', 1);
  });

  it('a concurrent tick while one is already running is a no-op (re-entrancy guard)', async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise((resolve) => {
      resolveFirst = resolve as () => void;
    });
    pool.query.mockImplementation(async () => {
      await gate;
      return { rows: [], rowCount: 0 };
    });

    const first = service.tick();
    const second = service.tick();
    resolveFirst?.();
    await Promise.all([first, second]);

    expect(pool.query).toHaveBeenCalledTimes(3);
  });
});
