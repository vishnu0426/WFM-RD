import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { entities, AdherenceEvent } from '../../src/database/entities';
import { withTenantConnection } from '../../src/database/with-tenant-connection';

dotenv.config();

/**
 * GAP-16 (enterprise readiness audit, 2026-08-18): `intraday.*`'s RLS
 * policies (ADR-0066) have never had a runtime proof of their own - only the
 * root service's 4 RLS-isolation specs exist. Same "talk to Postgres
 * directly, bypassing the app guard entirely" posture as the root's own
 * `rls-isolation.spec.ts`.
 */
describe('intraday.* RLS isolation (GAP-16)', () => {
  let appDataSource: DataSource; // agno_intraday_app, same role the running application uses

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  let eventAId: string;
  let eventBId: string;
  // Fixed, not `new Date()`: `InitialAdherenceSchema`'s partition bootstrap
  // only creates today ± 3 days of partitions *as of whenever that
  // migration ran* - no `AdherencePartitionSchedulerService` daily tick is
  // running in this test environment to keep extending it, so `new Date()`
  // at test-run time can land outside the partitions that actually exist.
  // Pick a date confirmed present via
  // `SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent =
  // 'intraday.adherence_event'::regclass` rather than assuming "now" works.
  const eventATimestamp = new Date('2026-08-12T10:00:00Z');
  const eventBTimestamp = new Date('2026-08-12T10:00:00Z');

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_intraday_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

    eventAId = randomUUID();
    eventBId = randomUUID();

    await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AdherenceEvent).save({
        id: eventAId,
        tenantId: tenantAId,
        employeeId: randomUUID(),
        eventType: 'activity_changed',
        fromActivity: null,
        toActivity: 'available',
        scheduledActivity: 'available',
        deviationSeconds: 0,
        timestamp: eventATimestamp,
      } as AdherenceEvent),
    );
    await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(AdherenceEvent).save({
        id: eventBId,
        tenantId: tenantBId,
        employeeId: randomUUID(),
        eventType: 'activity_changed',
        fromActivity: null,
        toActivity: 'available',
        scheduledActivity: 'available',
        deviationSeconds: 0,
        timestamp: eventBTimestamp,
      } as AdherenceEvent),
    );
  });

  afterAll(async () => {
    await appDataSource.destroy();
  });

  it("a tenant's session only sees its own adherence events", async () => {
    const seenByA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AdherenceEvent).find({ where: { id: eventAId } }),
    );
    expect(seenByA).toHaveLength(1);

    const crossTenant = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AdherenceEvent).find({ where: { id: eventBId } }),
    );
    expect(crossTenant).toHaveLength(0);
  });

  it('Postgres RLS holds even if the application guard is bypassed entirely', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_intraday_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      const result = await rawClient.query('SELECT id FROM intraday.adherence_event WHERE id = ANY($1::uuid[])', [
        [eventAId, eventBId],
      ]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await rawClient.end();
    }
  });

  it('a write with a mismatched tenant_id is rejected by the WITH CHECK clause, not silently rescoped', async () => {
    await expect(
      withTenantConnection(appDataSource, tenantAId, (manager) =>
        manager.getRepository(AdherenceEvent).save({
          id: randomUUID(),
          tenantId: tenantBId, // mismatched on purpose
          employeeId: randomUUID(),
          eventType: 'activity_changed',
          fromActivity: null,
          toActivity: 'available',
          scheduledActivity: 'available',
          deviationSeconds: 0,
          timestamp: eventATimestamp,
        } as AdherenceEvent),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('agno_intraday_app cannot read core/org/forecasting schemas (no cross-schema grant)', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_intraday_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      await expect(rawClient.query('SELECT 1 FROM core.users LIMIT 1')).rejects.toThrow(/permission denied/i);
    } finally {
      await rawClient.end();
    }
  });
});
