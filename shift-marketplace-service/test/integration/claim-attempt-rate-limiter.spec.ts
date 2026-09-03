import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { entities } from '../../src/database/entities';
import { ClaimAttemptRateLimiterService } from '../../src/marketplace/claim-attempt-rate-limiter.service';
import { ClaimAttemptRateLimitExceededError } from '../../src/marketplace/errors/claim-attempt-rate-limit-exceeded.error';

dotenv.config();

/**
 * §5.2's real-Postgres companion to `claim-attempt-rate-limiter.service.spec.ts`'s
 * mocked unit tests. This module's own build caught a real RLS bug in this
 * exact service (a first draft queried `marketplace_engagement_score`
 * directly instead of through `withTenantConnection`, which RLS would have
 * failed *closed* on rather than erroring loudly) - a mock can't catch that
 * class of bug since it doesn't know what RLS would actually do. Same
 * "stub what this test doesn't own, keep real what it does" posture as
 * `claim-open-shift-concurrency.spec.ts`: there is nothing to stub here,
 * this service's entire job is talking to real, RLS-protected Postgres.
 */
describe('ClaimAttemptRateLimiterService (§5.2, real Postgres)', () => {
  let appDataSource: DataSource; // agno_marketplace_app, RLS-restricted - what the running app uses
  let migratorDataSource: DataSource; // bypasses RLS - used only to prove the isolation boundary

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_marketplace_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

    migratorDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await migratorDataSource.initialize();
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  function makeConfig(limit: number, windowSeconds: number): ConfigService {
    return {
      get: jest.fn((key: string, defaultValue?: string) => {
        if (key === 'MARKETPLACE_CLAIM_ATTEMPT_LIMIT') return String(limit);
        if (key === 'MARKETPLACE_CLAIM_ATTEMPT_WINDOW_SECONDS') return String(windowSeconds);
        return defaultValue;
      }),
    } as unknown as ConfigService;
  }

  it('a fresh (tenant, employee) pair with no prior attempts is never rate-limited', async () => {
    const tenantId = randomUUID();
    const employeeId = randomUUID();
    const service = new ClaimAttemptRateLimiterService(appDataSource, makeConfig(3, 60));

    await expect(service.assertNotRateLimited(tenantId, employeeId)).resolves.toBeUndefined();
  });

  it('rejects with ClaimAttemptRateLimitExceededError once real recorded failures reach the configured limit', async () => {
    const tenantId = randomUUID();
    const employeeId = randomUUID();
    const service = new ClaimAttemptRateLimiterService(appDataSource, makeConfig(3, 60));

    await service.recordFailedAttempt(tenantId, employeeId);
    await service.recordFailedAttempt(tenantId, employeeId);
    await expect(service.assertNotRateLimited(tenantId, employeeId)).resolves.toBeUndefined();

    await service.recordFailedAttempt(tenantId, employeeId);
    await expect(service.assertNotRateLimited(tenantId, employeeId)).rejects.toBeInstanceOf(
      ClaimAttemptRateLimitExceededError,
    );
  });

  it('two genuinely concurrent recordFailedAttempt calls for the same pair both land (atomic upsert, no lost update)', async () => {
    const tenantId = randomUUID();
    const employeeId = randomUUID();
    const service = new ClaimAttemptRateLimiterService(appDataSource, makeConfig(10, 60));

    await Promise.all([
      service.recordFailedAttempt(tenantId, employeeId),
      service.recordFailedAttempt(tenantId, employeeId),
    ]);

    const rows = await migratorDataSource.query(
      `SELECT claim_attempt_count_window FROM marketplace.marketplace_engagement_score
       WHERE tenant_id = $1 AND employee_id = $2`,
      [tenantId, employeeId],
    );
    expect(rows[0].claim_attempt_count_window).toBe(2);
  });

  it('a failed attempt recorded under one tenant never counts toward another tenant, even for the same employee id', async () => {
    const employeeId = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const service = new ClaimAttemptRateLimiterService(appDataSource, makeConfig(1, 60));

    await service.recordFailedAttempt(tenantA, employeeId);

    await expect(service.assertNotRateLimited(tenantA, employeeId)).rejects.toBeInstanceOf(
      ClaimAttemptRateLimitExceededError,
    );
    await expect(service.assertNotRateLimited(tenantB, employeeId)).resolves.toBeUndefined();
  });

  it("RLS fails closed: reading marketplace_engagement_score without the tenant GUC set never returns another tenant's row", async () => {
    const tenantId = randomUUID();
    const employeeId = randomUUID();
    await migratorDataSource.query(
      `INSERT INTO marketplace.marketplace_engagement_score
         (employee_id, tenant_id, points, streak_days, badges, claim_attempt_count_window, claim_attempt_window_start)
       VALUES ($1, $2, 0, 0, '[]'::jsonb, 1, now())`,
      [employeeId, tenantId],
    );

    // Same app role, same table, but no `SET LOCAL app.current_tenant_id`
    // - exactly the bug this service's first draft had before it was
    // routed through `withTenantConnection`. Once any prior transaction on
    // this pooled connection has SET LOCAL'd the GUC and committed,
    // Postgres's reset value for that custom GUC becomes '' (not NULL,
    // a real, easy-to-miss Postgres quirk for placeholder GUCs) - `''::uuid`
    // fails the cast outright rather than silently comparing false. Either
    // way (a thrown error or a filtered-out NULL comparison on a
    // never-touched connection) the row is never visible - RLS still fails
    // closed, it just doesn't always fail closed the *same way*.
    let rows: unknown[] = [];
    try {
      rows = await appDataSource.query(
        `SELECT * FROM marketplace.marketplace_engagement_score WHERE employee_id = $1 AND tenant_id = $2`,
        [employeeId, tenantId],
      );
    } catch (err) {
      expect((err as Error).message).toMatch(/invalid input syntax for type uuid/);
      return;
    }
    expect(rows).toHaveLength(0);
  });
});
