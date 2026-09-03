import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { DataSource } from 'typeorm';
import { Pool } from 'pg';
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
import { SalesforceAdapter } from '../../src/sync/batch/providers/salesforce.adapter';
import { MetricsService } from '../../src/common/metrics/metrics.service';

dotenv.config();

/**
 * §7 Phase 6b's fourth batch adapter, real end to end. Two things unique
 * to Salesforce among this module's batch providers: real REST query
 * pagination (`nextRecordsUrl`) followed within one `withBackoffRetry`
 * attempt, and the `header_driven` breach signal (a `403` +
 * `REQUEST_LIMIT_EXCEEDED` `errorCode`, not a `429`) ADR-0135's own seeded
 * row names - `rate-limiting.spec.ts` already proves the generic 429/
 * `Retry-After` reactive path against Workday; this test's value-add is
 * specifically the header_driven interpretation and pagination.
 */
describe('SalesforceAdapter (real Postgres + real Vault + real local Salesforce-shaped server + REAL Module 02 bulk-import)', () => {
  let appDataSource: DataSource;
  let migratorPool: Pool;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let fieldMappings: FieldMappingsService;
  let syncJobs: SyncJobsService;
  let sfServer: Server;
  let sfApiBaseUrl: string;
  let firstQueryAttempts = 0;
  const suffix = randomUUID().slice(0, 8);
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const orgUnitId = process.env.ACME_DEMO_SITE_ORG_UNIT_ID ?? '9ed1b40a-2a60-41da-8ceb-d553f775acd9';
  const sfToken = 'sf-fake-bearer-token-for-this-test';
  const createdConnectorIds: string[] = [];
  const createdEmployeeNumbers = [`SF-TEST-${suffix}-1`, `SF-TEST-${suffix}-2`];
  const soqlQuery = 'SELECT Id FROM Contact';

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
    migratorPool = new Pool({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });

    vault = new VaultClientService({
      addr: process.env.VAULT_ADDR,
      token: process.env.VAULT_TOKEN,
      kvMount: process.env.VAULT_KV_MOUNT ?? 'secret',
    });
    connectors = new IntegrationConnectorsService(appDataSource, vault, new OAuthTokenExchangeService(), { record: async () => undefined } as any);
    fieldMappings = new FieldMappingsService(appDataSource);
    syncJobs = makeRealSyncJobsService(appDataSource);

    sfServer = createServer((req, res) => {
      const encodedQuery = encodeURIComponent(soqlQuery);
      if (
        req.url === `/services/data/v59.0/query?q=${encodedQuery}` &&
        req.headers.authorization === `Bearer ${sfToken}`
      ) {
        firstQueryAttempts++;
        if (firstQueryAttempts === 1) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify([{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'TotalRequests Limit exceeded.' }]));
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            totalSize: 2,
            done: false,
            nextRecordsUrl: '/services/data/v59.0/query/01g-next',
            records: [
              {
                Contact_External_Id__c: createdEmployeeNumbers[0],
                OrgUnitId__c: orgUnitId,
                EmploymentType__c: 'Full-Time',
                HoursPerWeek__c: 40,
                HireDate__c: '2024-08-01',
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/services/data/v59.0/query/01g-next' && req.headers.authorization === `Bearer ${sfToken}`) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            totalSize: 2,
            done: true,
            records: [
              {
                Contact_External_Id__c: createdEmployeeNumbers[1],
                OrgUnitId__c: orgUnitId,
                EmploymentType__c: 'Part-Time',
                HoursPerWeek__c: 20,
                HireDate__c: '2024-09-01',
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 401;
      res.end('unauthorized or unknown path');
    });
    await new Promise<void>((resolve) => sfServer.listen(0, '127.0.0.1', resolve));
    const address = sfServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to start fake Salesforce server');
    sfApiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => sfServer.close(() => resolve()));
    await migratorPool.query(`DELETE FROM org.employees WHERE employee_number = ANY($1)`, [createdEmployeeNumbers]);
    if (createdConnectorIds.length) {
      await migratorPool.query(`DELETE FROM integration_hub.field_mapping WHERE connector_id = ANY($1)`, [
        createdConnectorIds,
      ]);
      await migratorPool.query(`DELETE FROM integration_hub.sync_job WHERE connector_id = ANY($1)`, [
        createdConnectorIds,
      ]);
      await migratorPool.query(`DELETE FROM integration_hub.integration_connector WHERE id = ANY($1)`, [
        createdConnectorIds,
      ]);
    }
    await migratorPool.end();
    await closeRealSyncJobsServiceConnections();
    await appDataSource.destroy();
  });

  async function withTemporarySalesforceBackoff(backoffStrategy: Record<string, unknown>, run: () => Promise<void>) {
    const { rows } = await migratorPool.query(
      `SELECT backoff_strategy FROM integration_hub.provider_rate_limit_config WHERE provider = 'Salesforce'`,
    );
    const original = rows[0].backoff_strategy;
    await migratorPool.query(
      `UPDATE integration_hub.provider_rate_limit_config SET backoff_strategy = $1::jsonb WHERE provider = 'Salesforce'`,
      [JSON.stringify(backoffStrategy)],
    );
    try {
      await run();
    } finally {
      await migratorPool.query(
        `UPDATE integration_hub.provider_rate_limit_config SET backoff_strategy = $1::jsonb WHERE provider = 'Salesforce'`,
        [JSON.stringify(original)],
      );
    }
  }

  it('retries a real header_driven 403/REQUEST_LIMIT_EXCEEDED breach, then paginates via nextRecordsUrl and commits both pages', async () => {
    await withTemporarySalesforceBackoff(
      {
        type: 'header_driven',
        on_breach_status: 403,
        on_breach_code: 'REQUEST_LIMIT_EXCEEDED',
        base_ms: 10,
        max_retries: 3,
      },
      async () => {
        const { connector } = await connectors.create(tenantId, {
          connectorType: ConnectorType.CRM,
          provider: 'Salesforce',
          credentials: { accessToken: sfToken },
          additionalConfig: { salesforceApiBaseUrl: sfApiBaseUrl, salesforceQuery: soqlQuery },
        });
        createdConnectorIds.push(connector.id);

        await fieldMappings.upsert(tenantId, {
          connectorId: connector.id,
          sourceField: 'Contact_External_Id__c',
          targetField: 'employeeNumber',
        });
        await fieldMappings.upsert(tenantId, {
          connectorId: connector.id,
          sourceField: 'OrgUnitId__c',
          targetField: 'orgUnitId',
        });
        await fieldMappings.upsert(tenantId, {
          connectorId: connector.id,
          sourceField: 'EmploymentType__c',
          targetField: 'employmentType',
          transformationRule: { valueMap: { 'Full-Time': 'full_time', 'Part-Time': 'part_time' } },
        });
        await fieldMappings.upsert(tenantId, {
          connectorId: connector.id,
          sourceField: 'HoursPerWeek__c',
          targetField: 'contractHoursPerWeek',
        });
        await fieldMappings.upsert(tenantId, {
          connectorId: connector.id,
          sourceField: 'HireDate__c',
          targetField: 'hireDate',
        });

        const metrics = new MetricsService();
        const recordSpy = jest.spyOn(metrics, 'recordRateLimitThrottle');
        const adapter = new SalesforceAdapter(
          vault,
          fieldMappings,
          new FieldAuthorityPoliciesService(appDataSource),
          new BulkImportClientService(),
          new ProviderRateLimitConfigService(appDataSource),
          metrics,
        );
        const job = await syncJobs.enqueue(tenantId, connector.id, SyncType.INCREMENTAL);
        const outcome = await adapter.sync(await connectors.findByIdForTenant(tenantId, connector.id), job);

        expect(recordSpy).toHaveBeenCalledWith('Salesforce', 'reactive_retry');
        expect(outcome.status).toBe(SyncJobStatus.COMPLETED);
        expect(outcome.recordsProcessed).toBe(2);

        const rows = await migratorPool.query(
          `SELECT employee_number, employment_type, contract_hours_per_week FROM org.employees WHERE employee_number = ANY($1) ORDER BY employee_number`,
          [createdEmployeeNumbers],
        );
        expect(rows.rows).toHaveLength(2);
        expect(rows.rows[0]).toMatchObject({
          employee_number: createdEmployeeNumbers[0],
          employment_type: 'full_time',
        });
        expect(rows.rows[1]).toMatchObject({
          employee_number: createdEmployeeNumbers[1],
          employment_type: 'part_time',
        });
      },
    );
  });
});
