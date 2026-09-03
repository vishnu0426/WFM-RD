import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { entities, AdherenceScore, ComplianceRule } from '../../src/database/entities';
import { AdherenceScorePeriodType } from '../../src/adherence/entities/adherence-score.entity';
import { ComplianceRuleType, ComplianceRuleStatus } from '../../src/compliance/entities/compliance-rule.entity';
import { withTenantConnection } from '../../src/database/with-tenant-connection';

dotenv.config();

/**
 * GAP-16 (enterprise readiness audit, 2026-08-18): `compliance.*`'s RLS
 * policies (ADR-0095) have never had a runtime proof of their own - only the
 * root service's 4 RLS-isolation specs exist. Same "talk to Postgres
 * directly, bypassing the app guard entirely" posture as the root's own
 * `rls-isolation.spec.ts`.
 */
describe('compliance.* RLS isolation (GAP-16)', () => {
  let appDataSource: DataSource; // agno_compliance_app, same role the running application uses
  let migratorDataSource: DataSource;

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  let scoreAId: string;
  let scoreBId: string;

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_compliance_app',
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
    const scoreA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AdherenceScore).save({
        id: randomUUID(),
        tenantId: tenantAId,
        employeeId: randomUUID(),
        periodType: AdherenceScorePeriodType.DAY,
        periodStart: now,
        periodEnd: now,
        adherentSeconds: 100,
        totalScheduledSeconds: 100,
        adherencePct: '100.00',
        majorDeviationCount: 0,
        computedAt: now,
      } as AdherenceScore),
    );
    const scoreB = await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(AdherenceScore).save({
        id: randomUUID(),
        tenantId: tenantBId,
        employeeId: randomUUID(),
        periodType: AdherenceScorePeriodType.DAY,
        periodStart: now,
        periodEnd: now,
        adherentSeconds: 100,
        totalScheduledSeconds: 100,
        adherencePct: '100.00',
        majorDeviationCount: 0,
        computedAt: now,
      } as AdherenceScore),
    );
    scoreAId = scoreA.id;
    scoreBId = scoreB.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  it("a tenant's session only sees its own adherence scores", async () => {
    const seenByA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AdherenceScore).find({ where: { id: scoreAId } }),
    );
    expect(seenByA).toHaveLength(1);

    const crossTenant = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AdherenceScore).find({ where: { id: scoreBId } }),
    );
    expect(crossTenant).toHaveLength(0);
  });

  it('Postgres RLS holds even if the application guard is bypassed entirely', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_compliance_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      const result = await rawClient.query('SELECT id FROM compliance.adherence_score WHERE id = ANY($1::uuid[])', [
        [scoreAId, scoreBId],
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
        manager.getRepository(AdherenceScore).save({
          id: randomUUID(),
          tenantId: tenantBId, // mismatched on purpose
          employeeId: randomUUID(),
          periodType: AdherenceScorePeriodType.DAY,
          periodStart: now,
          periodEnd: now,
          adherentSeconds: 100,
          totalScheduledSeconds: 100,
          adherencePct: '100.00',
          majorDeviationCount: 0,
          computedAt: now,
        } as AdherenceScore),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('agno_compliance_app cannot read core/org/forecasting schemas (no cross-schema grant)', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_compliance_app',
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

  it("ADR-0095's split policy: a platform-default compliance_rule (tenant_id IS NULL) is visible from every tenant but a tenant-scoped one is not", async () => {
    const now = new Date();
    const platformRule = await migratorDataSource.getRepository(ComplianceRule).save({
      id: randomUUID(),
      tenantId: null,
      jurisdiction: `ZZ${randomUUID().slice(0, 6)}`, // varchar(10) - short, still unique per run
      ruleType: ComplianceRuleType.OVERTIME_THRESHOLD,
      definition: { thresholdHours: 40 },
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
      version: 1,
      citation: 'RLS test fixture',
      status: ComplianceRuleStatus.ACTIVE,
      activationDelayUntil: null,
      createdAt: now,
      activatedAt: now,
    } as ComplianceRule);

    const tenantScopedRule = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(ComplianceRule).save({
        id: randomUUID(),
        tenantId: tenantAId,
        jurisdiction: `ZZ${randomUUID().slice(0, 6)}`, // varchar(10) - short, still unique per run
        ruleType: ComplianceRuleType.OVERTIME_THRESHOLD,
        definition: { thresholdHours: 35 },
        effectiveFrom: '2020-01-01',
        effectiveTo: null,
        version: 1,
        citation: 'RLS test fixture (tenant-scoped)',
        status: ComplianceRuleStatus.ACTIVE,
        activationDelayUntil: null,
        createdAt: now,
        activatedAt: now,
      } as ComplianceRule),
    );

    const seenByB = await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(ComplianceRule).find({ where: { id: platformRule.id } }),
    );
    expect(seenByB).toHaveLength(1);

    const tenantAsRuleSeenByB = await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(ComplianceRule).find({ where: { id: tenantScopedRule.id } }),
    );
    expect(tenantAsRuleSeenByB).toHaveLength(0);
  });
});
