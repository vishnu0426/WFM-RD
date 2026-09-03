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
import { AdpAdapter } from '../../src/sync/batch/providers/adp.adapter';
import { MetricsService } from '../../src/common/metrics/metrics.service';

dotenv.config();

/**
 * §7 Phase 6b's third batch adapter, real end to end. Two things this
 * test exists to prove that the other batch adapters' tests don't need
 * to: (1) ADR-0143's disclosed mTLS gap actually fails closed
 * (`missing_mtls_material`) rather than silently sending a bearer-only
 * request when Vault has no cert/key; (2) real dot-path field-mapping
 * extraction into a nested array (`workAssignments.0...`, ADP's actual
 * real response shape) works, not just flat-object extraction.
 *
 * The fake ADP server here only checks the bearer token, the same
 * simplification ADR-0143 documents - it does not (and given this
 * environment, cannot) terminate a real mTLS handshake.
 */
describe('AdpAdapter (real Postgres + real Vault + real local ADP-shaped server + REAL Module 02 bulk-import)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let fieldMappings: FieldMappingsService;
  let syncJobs: SyncJobsService;
  let adpServer: Server;
  let adpApiBaseUrl: string;
  const suffix = randomUUID().slice(0, 8);
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const orgUnitId = process.env.ACME_DEMO_SITE_ORG_UNIT_ID ?? '9ed1b40a-2a60-41da-8ceb-d553f775acd9';
  const adpToken = 'adp-fake-bearer-token-for-this-test';
  const createdConnectorIds: string[] = [];
  const createdEmployeeNumbers = [`ADP-TEST-${suffix}-1`];

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

    adpServer = createServer((req, res) => {
      if (req.url === '/hr/v2/workers?$top=100' && req.headers.authorization === `Bearer ${adpToken}`) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            workers: [
              {
                associateOID: createdEmployeeNumbers[0],
                workAssignments: [
                  {
                    homeOrganizationalUnit: orgUnitId,
                    assignmentStatus: { statusCode: { codeValue: 'FT' } },
                    standardHours: { hoursQuantity: 40 },
                  },
                ],
                originalHireDate: '2024-07-01',
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 401;
      res.end('unauthorized or unknown path');
    });
    await new Promise<void>((resolve) => adpServer.listen(0, '127.0.0.1', resolve));
    const address = adpServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to start fake ADP server');
    adpApiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => adpServer.close(() => resolve()));
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

  it('fails closed with missing_mtls_material when Vault has no client certificate', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.PAYROLL,
      provider: 'ADP',
      credentials: { accessToken: adpToken }, // no clientCertPem/clientKeyPem
      additionalConfig: { adpApiBaseUrl },
    });
    createdConnectorIds.push(connector.id);

    const adapter = new AdpAdapter(
      vault,
      fieldMappings,
      new FieldAuthorityPoliciesService(appDataSource),
      new BulkImportClientService(),
      new ProviderRateLimitConfigService(appDataSource),
      new MetricsService(),
    );
    const job = await syncJobs.enqueue(tenantId, connector.id, SyncType.INCREMENTAL);
    const outcome = await adapter.sync(await connectors.findByIdForTenant(tenantId, connector.id), job);

    expect(outcome.status).toBe(SyncJobStatus.FAILED);
    expect(outcome.errorDetails?.reason).toBe('missing_mtls_material');
  });

  it('extracts a real nested-array dot path, maps fields, and commits through the real Module 02 bulk-import once mTLS material is present', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.PAYROLL,
      provider: 'ADP',
      credentials: {
        accessToken: adpToken,
        clientCertPem: '-----BEGIN CERTIFICATE-----\nfake-test-cert\n-----END CERTIFICATE-----',
        clientKeyPem: '-----BEGIN PRIVATE KEY-----\nfake-test-key\n-----END PRIVATE KEY-----',
      },
      additionalConfig: { adpApiBaseUrl },
    });
    createdConnectorIds.push(connector.id);

    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'associateOID',
      targetField: 'employeeNumber',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'workAssignments.0.homeOrganizationalUnit',
      targetField: 'orgUnitId',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'workAssignments.0.assignmentStatus.statusCode.codeValue',
      targetField: 'employmentType',
      transformationRule: { valueMap: { FT: 'full_time', PT: 'part_time' } },
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'workAssignments.0.standardHours.hoursQuantity',
      targetField: 'contractHoursPerWeek',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'originalHireDate',
      targetField: 'hireDate',
    });

    const adapter = new AdpAdapter(
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
      `SELECT employee_number, employment_type, org_unit_id FROM org.employees WHERE employee_number = ANY($1)`,
      [createdEmployeeNumbers],
    );
    await migrator.destroy();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      employee_number: createdEmployeeNumbers[0],
      employment_type: 'full_time',
      org_unit_id: orgUnitId,
    });
  });
});
