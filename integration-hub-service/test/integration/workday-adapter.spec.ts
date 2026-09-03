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
import { ProviderRateLimitConfigService } from '../../src/sync/provider-rate-limit-config.service';
import { BulkImportClientService } from '../../src/sync/batch/providers/bulk-import-client.service';
import { WorkdayAdapter } from '../../src/sync/batch/providers/workday.adapter';
import { MetricsService } from '../../src/common/metrics/metrics.service';
import { closeRealSyncJobsServiceConnections, makeRealSyncJobsService } from './helpers/real-sync-jobs-service';

dotenv.config();

/**
 * §7 Phase 3's real end-to-end verification: real Postgres, real Vault,
 * a real local HTTP server standing in for Workday's REST API (no real
 * credentialed Workday tenant exists in this environment - see the Phase 3
 * design doc), and the REAL, already-built, already-running Module 02
 * `POST /v1/employees/bulk-import` (not a stand-in - this endpoint exists
 * in this same monorepo and was started for this run against the same
 * Postgres instance).
 *
 * Requires: the root platform-core service running on CORE_SERVICE_URL
 * (default http://localhost:3000), the "Acme Demo Corp" seed tenant
 * present (npm run seed at repo root), and `org.feature_flags`'s
 * `bulk_import_destructive` row enabled for that tenant - see the Phase 3
 * design doc's verification section for the exact commands used to set
 * this up for this run.
 */
describe('WorkdayAdapter (real Postgres + real Vault + real local Workday-shaped server + REAL Module 02 bulk-import)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let fieldMappings: FieldMappingsService;
  let syncJobs: SyncJobsService;
  let workdayServer: Server;
  let workdayApiBaseUrl: string;
  const suffix = randomUUID().slice(0, 8);
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const orgUnitId = process.env.ACME_DEMO_SITE_ORG_UNIT_ID ?? '9ed1b40a-2a60-41da-8ceb-d553f775acd9';
  const workdayToken = 'workday-fake-bearer-token-for-this-test';
  const createdConnectorIds: string[] = [];
  const createdEmployeeNumbers = [`WD-TEST-${suffix}-1`, `WD-TEST-${suffix}-2`];

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
    connectors = new IntegrationConnectorsService(appDataSource, vault, new OAuthTokenExchangeService(), { record: async () => undefined } as any);
    fieldMappings = new FieldMappingsService(appDataSource);
    syncJobs = makeRealSyncJobsService(appDataSource);

    workdayServer = createServer((req, res) => {
      if (req.url === '/workers' && req.headers.authorization === `Bearer ${workdayToken}`) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            data: [
              {
                workerId: createdEmployeeNumbers[0],
                organizationId: orgUnitId,
                employmentType: 'Full-Time',
                fte: 1.0,
                hireDate: '2024-03-01',
              },
              {
                workerId: createdEmployeeNumbers[1],
                organizationId: orgUnitId,
                employmentType: 'Part-Time',
                fte: 0.5,
                hireDate: '2024-04-15',
              },
              // A record with no organizationId at all - drops out after
              // mapping (isCompleteBulkImportRecord), proving incomplete
              // source records don't silently reach Module 02.
              {
                workerId: `WD-TEST-${suffix}-incomplete`,
                employmentType: 'Full-Time',
                fte: 1.0,
                hireDate: '2024-05-01',
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 401;
      res.end('unauthorized or unknown path');
    });
    await new Promise<void>((resolve) => workdayServer.listen(0, '127.0.0.1', resolve));
    const address = workdayServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to start fake Workday server');
    workdayApiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => workdayServer.close(() => resolve()));
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

  it('syncs real Workday-shaped data through field mapping into a real committed Module 02 bulk-import, end to end', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.HRIS,
      provider: 'Workday',
      credentials: { accessToken: workdayToken },
      additionalConfig: { workdayApiBaseUrl },
    });
    createdConnectorIds.push(connector.id);

    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'workerId',
      targetField: 'employeeNumber',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'organizationId',
      targetField: 'orgUnitId',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'employmentType',
      targetField: 'employmentType',
      transformationRule: { valueMap: { 'Full-Time': 'full_time', 'Part-Time': 'part_time' } },
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'fte',
      targetField: 'contractHoursPerWeek',
      transformationRule: { multiply: 40 },
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'hireDate',
      targetField: 'hireDate',
    });

    const adapter = new WorkdayAdapter(
      vault,
      fieldMappings,
      new FieldAuthorityPoliciesService(appDataSource),
      new BulkImportClientService(),
      new ProviderRateLimitConfigService(appDataSource),
      new MetricsService(),
    );
    const job = await syncJobs.enqueue(tenantId, connector.id, SyncType.INCREMENTAL);

    const outcome = await adapter.sync(await connectors.findByIdForTenant(tenantId, connector.id), job);

    // partial_failure, not completed - the fake Workday fixture deliberately
    // includes one record with no organizationId (dropped by field mapping,
    // never reaches Module 02), so the outcome must honestly reflect that
    // not everything fetched actually landed, per §5a's "never silently
    // truncate/report completed."
    expect(outcome.status).toBe(SyncJobStatus.PARTIAL_FAILURE);
    expect(outcome.recordsProcessed).toBe(2); // the two complete records
    expect(outcome.recordsFailed).toBe(1); // the one incomplete record (no orgUnitId)
    expect(outcome.recordsConflicted).toBe(0);

    // The real proof: the employees actually landed in Module 02's own
    // table, with the field-mapped/transformed values, via the real
    // bulk-import commit - not asserted from this service's own state.
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
      `SELECT employee_number, employment_type, contract_hours_per_week, org_unit_id, hire_date
       FROM org.employees WHERE employee_number = ANY($1) ORDER BY employee_number`,
      [createdEmployeeNumbers],
    );
    await migrator.destroy();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      employee_number: createdEmployeeNumbers[0],
      employment_type: 'full_time',
      org_unit_id: orgUnitId,
    });
    expect(Number(rows[0].contract_hours_per_week)).toBe(40);
    expect(rows[1]).toMatchObject({
      employee_number: createdEmployeeNumbers[1],
      employment_type: 'part_time',
      org_unit_id: orgUnitId,
    });
    expect(Number(rows[1].contract_hours_per_week)).toBe(20);
  });
});
