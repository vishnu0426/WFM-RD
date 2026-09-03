import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { entities, IntegrationConnector } from '../../src/database/entities';
import { ConnectorType, ConnectorStatus } from '../../src/integrations/entities/integration-connector.entity';
import { withTenantConnection } from '../../src/database/with-tenant-connection';

dotenv.config();

/**
 * GAP-16 (enterprise readiness audit, 2026-08-18): `integration_hub.*`'s RLS
 * policies have never had a runtime proof of their own - only the root
 * service's 4 RLS-isolation specs exist. Same "talk to Postgres directly,
 * bypassing the app guard entirely" posture as the root's own
 * `rls-isolation.spec.ts`.
 */
describe('integration_hub.* RLS isolation (GAP-16)', () => {
  let appDataSource: DataSource; // agno_integration_hub_app, same role the running application uses

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  let connectorAId: string;
  let connectorBId: string;

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_integration_hub_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

    const connectorA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(IntegrationConnector).save({
        id: randomUUID(),
        tenantId: tenantAId,
        connectorType: ConnectorType.HRIS,
        provider: 'rls-test-provider',
        status: ConnectorStatus.PENDING_SETUP,
        config: {},
        lastSyncAt: null,
        lastSyncStatus: null,
      } as IntegrationConnector),
    );
    const connectorB = await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(IntegrationConnector).save({
        id: randomUUID(),
        tenantId: tenantBId,
        connectorType: ConnectorType.HRIS,
        provider: 'rls-test-provider',
        status: ConnectorStatus.PENDING_SETUP,
        config: {},
        lastSyncAt: null,
        lastSyncStatus: null,
      } as IntegrationConnector),
    );
    connectorAId = connectorA.id;
    connectorBId = connectorB.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
  });

  it("a tenant's session only sees its own integration connectors", async () => {
    const seenByA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(IntegrationConnector).find({ where: { id: connectorAId } }),
    );
    expect(seenByA).toHaveLength(1);

    const crossTenant = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(IntegrationConnector).find({ where: { id: connectorBId } }),
    );
    expect(crossTenant).toHaveLength(0);
  });

  it('Postgres RLS holds even if the application guard is bypassed entirely', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_integration_hub_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      const result = await rawClient.query(
        'SELECT id FROM integration_hub.integration_connector WHERE id = ANY($1::uuid[])',
        [[connectorAId, connectorBId]],
      );
      expect(result.rows).toHaveLength(0);
    } finally {
      await rawClient.end();
    }
  });

  it('a write with a mismatched tenant_id is rejected by the WITH CHECK clause, not silently rescoped', async () => {
    await expect(
      withTenantConnection(appDataSource, tenantAId, (manager) =>
        manager.getRepository(IntegrationConnector).save({
          id: randomUUID(),
          tenantId: tenantBId, // mismatched on purpose
          connectorType: ConnectorType.HRIS,
          provider: 'rls-test-provider',
          status: ConnectorStatus.PENDING_SETUP,
          config: {},
          lastSyncAt: null,
          lastSyncStatus: null,
        } as IntegrationConnector),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('agno_integration_hub_app cannot read core/org/forecasting schemas (no cross-schema grant)', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_integration_hub_app',
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
