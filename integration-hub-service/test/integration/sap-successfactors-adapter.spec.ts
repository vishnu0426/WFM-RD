import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { DataSource } from 'typeorm';
import { entities } from '../../src/database/entities';
import { ConnectorType, SyncJobStatus } from '../../src/integrations/entities/integration-connector.entity';
import { SyncType } from '../../src/integrations/entities/sync-job.entity';
import { VaultClientService } from '../../src/vault/vault-client.service';
import { IntegrationConnectorsService } from '../../src/connectors/integration-connectors.service';
import { OAuthTokenExchangeService } from '../../src/connectors/oauth-token-exchange.service';
import { FieldMappingsService } from '../../src/connectors/field-mappings.service';
import { FieldAuthorityPoliciesService } from '../../src/connectors/field-authority-policies.service';
import { SyncJobsService } from '../../src/sync/sync-jobs.service';
import { closeRealSyncJobsServiceConnections, makeRealSyncJobsService } from './helpers/real-sync-jobs-service';
import { ProviderRateLimitConfigService } from '../../src/sync/provider-rate-limit-config.service';
import { BulkImportClientService } from '../../src/sync/batch/providers/bulk-import-client.service';
import { SapSuccessFactorsAdapter } from '../../src/sync/batch/providers/sap-successfactors.adapter';
import { MetricsService } from '../../src/common/metrics/metrics.service';

dotenv.config();

/**
 * §7 Phase 6b's second batch adapter, real end to end: real Postgres, real
 * Vault, a real local HTTP server standing in for SAP SuccessFactors'
 * actual OData v2 envelope shape (`{d: {results: [...]}}` - not the bare
 * array `WorkdayAdapter`'s own fixture uses), and the REAL Module 02
 * bulk-import, proving the envelope-unwrap plus the shared dry-run/commit
 * pipeline `WorkdayAdapter`'s own Phase 3 test already proved in full
 * depth - this test's own value-add is specifically the OData envelope.
 */
describe('SapSuccessFactorsAdapter (real Postgres + real Vault + real local SAP-shaped OData server + REAL Module 02 bulk-import)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let fieldMappings: FieldMappingsService;
  let syncJobs: SyncJobsService;
  let sapServer: Server;
  let sapApiBaseUrl: string;
  const suffix = randomUUID().slice(0, 8);
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const orgUnitId = process.env.ACME_DEMO_SITE_ORG_UNIT_ID ?? '9ed1b40a-2a60-41da-8ceb-d553f775acd9';
  const sapToken = 'sap-fake-bearer-token-for-this-test';
  const createdConnectorIds: string[] = [];
  const createdEmployeeNumbers = [`SAP-TEST-${suffix}-1`];

  beforeAll(async () => {
    if (!process.env.VAULT_ADDR || !process.env.VAULT_TOKEN) {
      throw new Error('VAULT_ADDR/VAULT_TOKEN must be set to run this integration test.');
    }

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

    vault = new VaultClientService({
      addr: process.env.VAULT_ADDR,
      token: process.env.VAULT_TOKEN,
      kvMount: process.env.VAULT_KV_MOUNT ?? 'secret',
    });
    connectors = new IntegrationConnectorsService(appDataSource, vault, new OAuthTokenExchangeService());
    fieldMappings = new FieldMappingsService(appDataSource);
    syncJobs = makeRealSyncJobsService(appDataSource);

    sapServer = createServer((req, res) => {
      if (req.url === '/odata/v2/PerPerson?$format=json' && req.headers.authorization === `Bearer ${sapToken}`) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            d: {
              results: [
                {
                  personIdExternal: createdEmployeeNumbers[0],
                  companyId: orgUnitId,
                  employmentType: 'FT',
                  fteRatio: 1.0,
                  startDate: '2024-06-01',
                },
              ],
            },
          }),
        );
        return;
      }
      res.statusCode = 401;
      res.end('unauthorized or unknown path');
    });
    await new Promise<void>((resolve) => sapServer.listen(0, '127.0.0.1', resolve));
    const address = sapServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to start fake SAP server');
    sapApiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => sapServer.close(() => resolve()));
    const migrator = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await migrator.initialize();
    await migrator.query(`DELETE FROM org.employees WHERE employee_number = ANY($1)`, [createdEmployeeNumbers]);
    if (createdConnectorIds.length) {
      await migrator.query(`DELETE FROM integration_hub.field_mapping WHERE connector_id = ANY($1)`, [
        createdConnectorIds,
      ]);
      await migrator.query(`DELETE FROM integration_hub.sync_job WHERE connector_id = ANY($1)`, [createdConnectorIds]);
      await migrator.query(`DELETE FROM integration_hub.integration_connector WHERE id = ANY($1)`, [
        createdConnectorIds,
      ]);
    }
    await migrator.destroy();
    await closeRealSyncJobsServiceConnections();
    await appDataSource.destroy();
  });

  it('unwraps a real OData v2 envelope, maps fields, and commits through the real Module 02 bulk-import', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.HRIS,
      provider: 'SAP SuccessFactors',
      credentials: { accessToken: sapToken },
      additionalConfig: { sapApiBaseUrl },
    });
    createdConnectorIds.push(connector.id);

    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'personIdExternal',
      targetField: 'employeeNumber',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'companyId',
      targetField: 'orgUnitId',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'employmentType',
      targetField: 'employmentType',
      transformationRule: { valueMap: { FT: 'full_time', PT: 'part_time' } },
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'fteRatio',
      targetField: 'contractHoursPerWeek',
      transformationRule: { multiply: 40 },
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'startDate',
      targetField: 'hireDate',
    });

    const adapter = new SapSuccessFactorsAdapter(
      vault,
      fieldMappings,
      new FieldAuthorityPoliciesService(appDataSource),
      new BulkImportClientService(),
      new ProviderRateLimitConfigService(appDataSource),
      new MetricsService(),
    );
    const job = await syncJobs.enqueue(tenantId, connector.id, SyncType.INCREMENTAL);
    const outcome = await adapter.sync(await connectors.findByIdForTenant(tenantId, connector.id), job);

    expect(outcome.status).toBe(SyncJobStatus.COMPLETED);
    expect(outcome.recordsProcessed).toBe(1);
    expect(outcome.recordsFailed).toBe(0);

    const migrator = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await migrator.initialize();
    const rows = await migrator.query(
      `SELECT employee_number, employment_type, contract_hours_per_week, org_unit_id FROM org.employees WHERE employee_number = ANY($1)`,
      [createdEmployeeNumbers],
    );
    await migrator.destroy();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      employee_number: createdEmployeeNumbers[0],
      employment_type: 'full_time',
      org_unit_id: orgUnitId,
    });
    expect(Number(rows[0].contract_hours_per_week)).toBe(40);
  });
});
