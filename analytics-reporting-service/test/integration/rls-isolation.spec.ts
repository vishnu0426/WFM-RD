import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { entities, SavedReport, MetricDefinition } from '../../src/database/entities';
import { SavedReportType } from '../../src/analytics/entities/saved-report.entity';
import { MetricCategory } from '../../src/analytics/entities/metric-definition.entity';
import { withTenantConnection } from '../../src/database/with-tenant-connection';

dotenv.config();

/**
 * GAP-16 (enterprise readiness audit, 2026-08-18): `analytics.*`'s RLS
 * policies have never had a runtime proof of their own - only the root
 * service's 4 RLS-isolation specs exist. Same "talk to Postgres directly,
 * bypassing the app guard entirely" posture as the root's own
 * `rls-isolation.spec.ts`. This service wasn't in the audit's original "9
 * non-root services" count (it postdates that pass) - closed here for the
 * same reason as the other 8.
 */
describe('analytics.* RLS isolation (GAP-16)', () => {
  let appDataSource: DataSource; // agno_analytics_app, same role the running application uses
  let migratorDataSource: DataSource;

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  let reportAId: string;
  let reportBId: string;

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_analytics_app',
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

    const now = new Date();
    const reportA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(SavedReport).save({
        id: randomUUID(),
        tenantId: tenantAId,
        createdBy: randomUUID(),
        name: 'rls test report A',
        reportType: SavedReportType.AD_HOC,
        config: {},
        scheduleCron: null,
        sharedWith: [],
        createdAt: now,
        updatedAt: now,
      } as SavedReport),
    );
    const reportB = await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(SavedReport).save({
        id: randomUUID(),
        tenantId: tenantBId,
        createdBy: randomUUID(),
        name: 'rls test report B',
        reportType: SavedReportType.AD_HOC,
        config: {},
        scheduleCron: null,
        sharedWith: [],
        createdAt: now,
        updatedAt: now,
      } as SavedReport),
    );
    reportAId = reportA.id;
    reportBId = reportB.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  it("a tenant's session only sees its own saved reports", async () => {
    const seenByA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(SavedReport).find({ where: { id: reportAId } }),
    );
    expect(seenByA).toHaveLength(1);

    const crossTenant = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(SavedReport).find({ where: { id: reportBId } }),
    );
    expect(crossTenant).toHaveLength(0);
  });

  it('Postgres RLS holds even if the application guard is bypassed entirely', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_analytics_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      const result = await rawClient.query('SELECT id FROM analytics.saved_report WHERE id = ANY($1::uuid[])', [
        [reportAId, reportBId],
      ]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await rawClient.end();
    }
  });

  it('a write with a mismatched tenant_id is rejected by the WITH CHECK clause, not silently rescoped', async () => {
    const now = new Date();
    await expect(
      withTenantConnection(appDataSource, tenantAId, (manager) =>
        manager.getRepository(SavedReport).save({
          id: randomUUID(),
          tenantId: tenantBId, // mismatched on purpose
          createdBy: randomUUID(),
          name: 'rls test mismatch',
          reportType: SavedReportType.AD_HOC,
          config: {},
          scheduleCron: null,
          sharedWith: [],
          createdAt: now,
          updatedAt: now,
        } as SavedReport),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('agno_analytics_app cannot read core/org/forecasting schemas (no cross-schema grant)', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_analytics_app',
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

  it("ADR-0095's split policy: a platform-default metric_definition (tenant_id IS NULL) is visible from every tenant but a tenant-authored one is not", async () => {
    const now = new Date();
    const platformMetric = await migratorDataSource.getRepository(MetricDefinition).save({
      id: randomUUID(),
      tenantId: null,
      name: `rls-test-platform-${randomUUID()}`,
      calculationDefinition: {},
      category: MetricCategory.ATTENDANCE,
      validatedAt: null,
      estimatedCostTier: null,
      createdAt: now,
      updatedAt: now,
    } as MetricDefinition);

    const tenantMetric = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(MetricDefinition).save({
        id: randomUUID(),
        tenantId: tenantAId,
        name: `rls-test-tenant-${randomUUID()}`,
        calculationDefinition: {},
        category: MetricCategory.ATTENDANCE,
        validatedAt: null,
        estimatedCostTier: null,
        createdAt: now,
        updatedAt: now,
      } as MetricDefinition),
    );

    const seenByB = await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(MetricDefinition).find({ where: { id: platformMetric.id } }),
    );
    expect(seenByB).toHaveLength(1);

    const tenantAsMetricSeenByB = await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(MetricDefinition).find({ where: { id: tenantMetric.id } }),
    );
    expect(tenantAsMetricSeenByB).toHaveLength(0);
  });
});
