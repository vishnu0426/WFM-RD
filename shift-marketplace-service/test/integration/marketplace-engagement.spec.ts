import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { entities } from '../../src/database/entities';
import { MarketplaceEngagementService } from '../../src/marketplace/marketplace-engagement.service';
import { MarketplaceEngagementEventType } from '../../src/marketplace/entities/marketplace-engagement-event.entity';

dotenv.config();

/**
 * §2.2 rule 3/ADR-0091's real-Postgres companion to
 * `marketplace-engagement.service.spec.ts`'s mocked unit tests. The
 * `SELECT ... FOR UPDATE` lost-update guard this service relies on can
 * only be proven against a real database - a mock can't demonstrate that
 * two genuinely concurrent writers actually serialize on the row rather
 * than both computing off the same stale snapshot.
 */
describe('MarketplaceEngagementService (§2.2 rule 3, real Postgres)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;

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

  function makeConfig(): ConfigService {
    return {
      get: jest.fn((_key: string, defaultValue?: string) => defaultValue),
    } as unknown as ConfigService;
  }

  it('a first event creates the score row, a matching ledger row, and awards first_fill', async () => {
    const tenantId = randomUUID();
    const employeeId = randomUUID();
    const referenceId = randomUUID();
    const service = new MarketplaceEngagementService(appDataSource, makeConfig());

    const result = await service.recordEvent({
      tenantId,
      employeeId,
      eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
      referenceId,
    });

    expect(result.points).toBe(10);
    expect(result.streakDays).toBe(1);
    expect(result.badges).toEqual(['first_fill']);

    const events = await migratorDataSource.query(
      `SELECT event_type, reference_id, points_delta, streak_days_after, badges_awarded
       FROM marketplace.marketplace_engagement_event
       WHERE tenant_id = $1 AND employee_id = $2`,
      [tenantId, employeeId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('claim_approved');
    expect(events[0].reference_id).toBe(referenceId);
    expect(events[0].points_delta).toBe(10);
    expect(events[0].badges_awarded).toEqual(['first_fill']);
  });

  it('two genuinely concurrent events for the same employee both land - no lost update on points', async () => {
    const tenantId = randomUUID();
    const employeeId = randomUUID();
    const service = new MarketplaceEngagementService(appDataSource, makeConfig());

    await Promise.all([
      service.recordEvent({
        tenantId,
        employeeId,
        eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
        referenceId: randomUUID(),
      }),
      service.recordEvent({
        tenantId,
        employeeId,
        eventType: MarketplaceEngagementEventType.SWAP_EXECUTED,
        referenceId: randomUUID(),
      }),
    ]);

    const rows = await migratorDataSource.query(
      `SELECT points FROM marketplace.marketplace_engagement_score WHERE tenant_id = $1 AND employee_id = $2`,
      [tenantId, employeeId],
    );
    // 10 (claim_approved) + 5 (swap_executed), regardless of which one's
    // transaction committed first - `FOR UPDATE` serializes them, so
    // neither computes its new total off the other's stale snapshot.
    expect(rows[0].points).toBe(15);

    const events = await migratorDataSource.query(
      `SELECT id FROM marketplace.marketplace_engagement_event WHERE tenant_id = $1 AND employee_id = $2`,
      [tenantId, employeeId],
    );
    expect(events).toHaveLength(2);
  });

  it('the same employee id under two different tenants gets two fully isolated scores', async () => {
    const employeeId = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const service = new MarketplaceEngagementService(appDataSource, makeConfig());

    await service.recordEvent({
      tenantId: tenantA,
      employeeId,
      eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
      referenceId: randomUUID(),
    });

    const scoreB = await service.recordEvent({
      tenantId: tenantB,
      employeeId,
      eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
      referenceId: randomUUID(),
    });

    // Tenant B's own first event, unaffected by tenant A's - points reset
    // to a fresh 10, not accumulated across tenants, and its own
    // first_fill badge fires independently.
    expect(scoreB.points).toBe(10);
    expect(scoreB.badges).toEqual(['first_fill']);
  });
});
