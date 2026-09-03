import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { entities, MarketplacePost } from '../../src/database/entities';
import { MarketplacePostStatus, MarketplacePostType } from '../../src/marketplace/entities/marketplace-post.entity';
import { withTenantConnection } from '../../src/database/with-tenant-connection';

dotenv.config();

/**
 * GAP-16 (enterprise readiness audit, 2026-08-18): `marketplace.*`'s RLS
 * policies (InitialMarketplaceSchema1700001000000) have never had a runtime
 * proof of their own - only the root service's 4 RLS-isolation specs exist.
 * Same "talk to Postgres directly, bypassing the app guard entirely" posture
 * as `rls-isolation.spec.ts` there: proves the policy holds on its own, not
 * just that `withTenantConnection` remembers to call `set_config` correctly.
 */
describe('marketplace.* RLS isolation (GAP-16)', () => {
  let appDataSource: DataSource; // agno_marketplace_app, same role the running application uses
  let migratorDataSource: DataSource;

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  let postAId: string;
  let postBId: string;

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

    const postA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(MarketplacePost).save({
        id: randomUUID(),
        tenantId: tenantAId,
        postType: MarketplacePostType.OPEN_SHIFT,
        shiftAssignmentId: randomUUID(),
        orgUnitId: randomUUID(),
        postedBy: null,
        status: MarketplacePostStatus.OPEN,
        eligibilityRules: {},
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
      } as MarketplacePost),
    );
    const postB = await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(MarketplacePost).save({
        id: randomUUID(),
        tenantId: tenantBId,
        postType: MarketplacePostType.OPEN_SHIFT,
        shiftAssignmentId: randomUUID(),
        orgUnitId: randomUUID(),
        postedBy: null,
        status: MarketplacePostStatus.OPEN,
        eligibilityRules: {},
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
      } as MarketplacePost),
    );
    postAId = postA.id;
    postBId = postB.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  it("a tenant's session only sees its own marketplace posts", async () => {
    const seenByA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(MarketplacePost).find({ where: { id: postAId } }),
    );
    expect(seenByA).toHaveLength(1);

    const crossTenant = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(MarketplacePost).find({ where: { id: postBId } }),
    );
    expect(crossTenant).toHaveLength(0);
  });

  it('Postgres RLS holds even if the application guard is bypassed entirely', async () => {
    // No withTenantConnection, no set_config at all - simulates a future bug
    // where someone queries marketplace.* outside the helper.
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_marketplace_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      const result = await rawClient.query('SELECT id FROM marketplace.marketplace_post WHERE id = ANY($1::uuid[])', [
        [postAId, postBId],
      ]);
      // No session tenant bound -> current_setting(...) is NULL -> every
      // policy's USING clause is false -> zero rows, not all rows.
      expect(result.rows).toHaveLength(0);
    } finally {
      await rawClient.end();
    }
  });

  it('a write with a mismatched tenant_id is rejected by the WITH CHECK clause, not silently rescoped', async () => {
    await expect(
      withTenantConnection(appDataSource, tenantAId, (manager) =>
        manager.getRepository(MarketplacePost).save({
          id: randomUUID(),
          tenantId: tenantBId, // mismatched on purpose
          postType: MarketplacePostType.OPEN_SHIFT,
          shiftAssignmentId: randomUUID(),
          orgUnitId: randomUUID(),
          postedBy: null,
          status: MarketplacePostStatus.OPEN,
          eligibilityRules: {},
          expiresAt: new Date(Date.now() + 86_400_000),
          createdAt: new Date(),
        } as MarketplacePost),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('agno_marketplace_app cannot read core/org/forecasting schemas (no cross-schema grant)', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_marketplace_app',
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
