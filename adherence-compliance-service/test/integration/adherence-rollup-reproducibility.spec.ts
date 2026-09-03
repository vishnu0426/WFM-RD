import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { AdherenceDailyRollupJobService } from '../../src/adherence/adherence-daily-rollup-job.service';
import { MetricsService } from '../../src/common/metrics/metrics.service';
import { TimezoneResolverService } from '../../src/adherence/timezone-resolver.service';

dotenv.config();

/**
 * §0.5's own defining correctness property for this module, made concrete:
 * "the same report requested twice for the same period returns the same
 * numbers." Requires a reachable Postgres with both this service's own
 * migration *and* intraday-service's own migration already applied (`npm
 * run migration:run` in both service directories) - there is no way to
 * meaningfully fake "the rollup query is deterministic against real,
 * partitioned, RLS-scoped data" with a mock.
 *
 * Uses `agno_migrator` directly, the same credentials
 * `migratorPoolProvider` wraps - this is exactly the cross-schema,
 * cross-tenant access pattern ADR-0098 documents, not a test-only
 * shortcut. Random tenant/employee ids per run, no explicit cleanup - same
 * convention shift-marketplace-service's own concurrency integration test
 * already uses.
 */
describe('AdherenceDailyRollupJobService reproducibility (§0.5)', () => {
  let pool: Pool;
  let service: AdherenceDailyRollupJobService;
  const tenantId = randomUUID();
  const employeeId = randomUUID();

  const stubConfig = {
    get: (key: string) => {
      if (key === 'ADHERENCE_DAILY_ROLLUP_TRAILING_DAYS') return 0; // only today - isolates this test's own window
      if (key === 'ADHERENCE_MAJOR_DEVIATION_THRESHOLD_SECONDS') return 300;
      return undefined;
    },
  } as unknown as ConfigService;
  const stubMetrics = {
    recordRollupJobRun: () => undefined,
    observeRollupJobLag: () => undefined,
  } as unknown as MetricsService;
  // This test's own seeded events are anchored to UTC midnight (`Date.UTC`)
  // and its hand-computed expected values assume UTC day boundaries -
  // stubbing timezone resolution to always return UTC keeps this test
  // exercising the segment/threshold computation in isolation from
  // ADR-0099's timezone-resolution path, which
  // `adherence-daily-rollup-job.service.spec.ts`'s own unit tests cover
  // separately (mocked gRPC clients, no live Postgres needed there).
  const stubTimezoneResolver = {
    resolveTimezones: async (_tenantId: string, employeeIds: string[]) => new Map(employeeIds.map((id) => [id, 'UTC'])),
  } as unknown as TimezoneResolverService;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    service = new AdherenceDailyRollupJobService(pool, stubConfig, stubMetrics, stubTimezoneResolver);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('re-running the same day twice against immutable events produces byte-identical numbers, updating only computed_at', async () => {
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // Four hand-chosen events -> four segments with a cleanly computable
    // expected result, exercising both the adherent/non-adherent split and
    // the major-deviation threshold. Each segment's duration is attributed
    // to the *earlier* event's own scheduled_activity (this computation's
    // own defined semantics, ADR-0098) - segment i runs from Event[i] to
    // Event[i+1] (or period_end for the last one), classified by Event[i]:
    //   seg(E1) = E2-E1 =  3600s, E1.scheduled_activity = 'on_shift' -> adherent
    //   seg(E2) = E3-E2 =   600s, E2.scheduled_activity = null       -> non-adherent, major (>=300s)
    //   seg(E3) = E4-E3 =   120s, E3.scheduled_activity = 'on_shift' -> adherent
    //   seg(E4) = end-E4 = 78480s, E4.scheduled_activity = 'on_shift' -> adherent
    // total = 82800s, adherent = 3600+120+78480 = 82200s -> 82200/82800*100 = 99.28%, 1 major deviation (seg(E2))
    const offsets = [3600, 7200, 7800, 7920];
    const scheduledActivities = ['on_shift', null, 'on_shift', 'on_shift'];
    for (let i = 0; i < offsets.length; i++) {
      await pool.query(
        `INSERT INTO intraday.adherence_event (id, tenant_id, employee_id, event_type, to_activity, scheduled_activity, deviation_seconds, "timestamp")
         VALUES ($1, $2, $3, 'activity_changed', 'available', $4, 0, $5)`,
        [
          randomUUID(),
          tenantId,
          employeeId,
          scheduledActivities[i],
          new Date(periodStart.getTime() + offsets[i] * 1000),
        ],
      );
    }

    await service.tick();
    const firstRun = await queryScore();
    expect(firstRun).toMatchObject({
      adherent_seconds: 82200,
      total_scheduled_seconds: 82800,
      adherence_pct: '99.28',
      major_deviation_count: 1,
    });
    const firstComputedAt = firstRun.computed_at;
    const firstId = firstRun.id;

    // A real, observable wait so a second `now()` call is guaranteed to
    // differ from the first at Postgres's own timestamp resolution.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await service.tick();
    const secondRun = await queryScore();

    // The reproducibility property itself: identical row identity, identical
    // computed numbers - re-running against the same immutable input events
    // converges on the same answer, not a drifting one.
    expect(secondRun.id).toBe(firstId);
    expect(secondRun.adherent_seconds).toBe(firstRun.adherent_seconds);
    expect(secondRun.total_scheduled_seconds).toBe(firstRun.total_scheduled_seconds);
    expect(secondRun.adherence_pct).toBe(firstRun.adherence_pct);
    expect(secondRun.major_deviation_count).toBe(firstRun.major_deviation_count);
    // ...while `computed_at` (deliberately distinct from `period_end`,
    // entity's own doc comment) proves the second tick genuinely re-ran the
    // computation rather than skipping it.
    expect(secondRun.computed_at.getTime()).toBeGreaterThan(firstComputedAt.getTime());
  }, 20000);

  async function queryScore(): Promise<{
    id: string;
    adherent_seconds: number;
    total_scheduled_seconds: number;
    adherence_pct: string;
    major_deviation_count: number;
    computed_at: Date;
  }> {
    const result = await pool.query(
      `SELECT id, adherent_seconds, total_scheduled_seconds, adherence_pct, major_deviation_count, computed_at
       FROM compliance.adherence_score
       WHERE tenant_id = $1 AND employee_id = $2 AND period_type = 'day'`,
      [tenantId, employeeId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  }
});
