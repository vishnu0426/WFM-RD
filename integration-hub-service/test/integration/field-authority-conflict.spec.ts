import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { DataSource } from 'typeorm';
import { entities } from '../../src/database/entities';
import { ConnectorType, SyncJobStatus } from '../../src/integrations/entities/integration-connector.entity';
import { SyncType } from '../../src/integrations/entities/sync-job.entity';
import {
  FieldAuthoritySource,
  FieldConflictAction,
} from '../../src/integrations/entities/field-authority-policy.entity';
import { VaultClientService } from '../../src/vault/vault-client.service';
import { IntegrationConnectorsService } from '../../src/connectors/integration-connectors.service';
import { OAuthTokenExchangeService } from '../../src/connectors/oauth-token-exchange.service';
import { FieldMappingsService } from '../../src/connectors/field-mappings.service';
import { FieldAuthorityPoliciesService } from '../../src/connectors/field-authority-policies.service';
import { FieldAuthorityPolicyNotApplicableError } from '../../src/connectors/errors/field-authority-policy-not-applicable.error';
import { FieldMappingAuthorityNotApplicableError } from '../../src/connectors/errors/field-mapping-authority-not-applicable.error';
import { FieldMappingAuthority } from '../../src/integrations/entities/field-mapping.entity';
import { SyncJobsService } from '../../src/sync/sync-jobs.service';
import { closeRealSyncJobsServiceConnections, makeRealSyncJobsService } from './helpers/real-sync-jobs-service';
import { ProviderRateLimitConfigService } from '../../src/sync/provider-rate-limit-config.service';
import { BulkImportClientService } from '../../src/sync/batch/providers/bulk-import-client.service';
import { WorkdayAdapter } from '../../src/sync/batch/providers/workday.adapter';
import { MetricsService } from '../../src/common/metrics/metrics.service';

dotenv.config();

/**
 * §7 Phase 4's real end-to-end verification of §5b: real Postgres, real
 * Vault, a real local Workday-shaped HTTP server, and the REAL Module 02
 * bulk-import - the same rigor bar Phase 3 set, extended to prove
 * `flag_for_review` genuinely reverts only the conflicting field (other
 * real changes on the same record still commit) and `reject_sync`
 * genuinely excludes the whole record, by querying `org.employees`
 * directly before and after each sync, not by trusting this module's own
 * reported outcome alone.
 */
describe('FieldAuthorityPolicy conflict detection (real Postgres + real Vault + real local Workday-shaped server + REAL Module 02)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let fieldMappings: FieldMappingsService;
  let fieldAuthorityPolicies: FieldAuthorityPoliciesService;
  let syncJobs: SyncJobsService;
  let fakeServer: Server;
  let fakeApiBaseUrl: string;
  let fixture: Record<string, unknown>[] = [];
  const suffix = randomUUID().slice(0, 8);
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const orgUnitId = process.env.ACME_DEMO_SITE_ORG_UNIT_ID ?? '9ed1b40a-2a60-41da-8ceb-d553f775acd9';
  const token = 'fap-fake-bearer-token';
  const empFlagged = `EMP-FAP-${suffix}-FLAG`;
  const empRejected = `EMP-FAP-${suffix}-REJECT`;
  const createdConnectorIds: string[] = [];

  async function runSync(connectorId: string) {
    const adapter = new WorkdayAdapter(
      vault,
      fieldMappings,
      fieldAuthorityPolicies,
      new BulkImportClientService(),
      new ProviderRateLimitConfigService(appDataSource),
      new MetricsService(),
    );
    const job = await syncJobs.enqueue(tenantId, connectorId, SyncType.INCREMENTAL);
    const connector = await connectors.findByIdForTenant(tenantId, connectorId);
    return adapter.sync(connector, job);
  }

  async function currentEmployeeRow(
    employeeNumber: string,
  ): Promise<{ cost_center: string; employment_type: string } | undefined> {
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
      `SELECT cost_center, employment_type FROM org.employees WHERE employee_number = $1`,
      [employeeNumber],
    );
    await migrator.destroy();
    return rows[0];
  }

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
    fieldAuthorityPolicies = new FieldAuthorityPoliciesService(appDataSource);
    syncJobs = makeRealSyncJobsService(appDataSource);

    fakeServer = createServer((req, res) => {
      if (req.url === '/workers' && req.headers.authorization === `Bearer ${token}`) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify({ data: fixture }));
        return;
      }
      res.statusCode = 401;
      res.end('unauthorized');
    });
    await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
    const address = fakeServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to start fake server');
    fakeApiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
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
    await migrator.query(`DELETE FROM org.employees WHERE employee_number = ANY($1)`, [[empFlagged, empRejected]]);
    if (createdConnectorIds.length) {
      await migrator.query(`DELETE FROM integration_hub.field_authority_policy WHERE connector_id = ANY($1)`, [
        createdConnectorIds,
      ]);
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

  it('flag_for_review reverts only the conflicting field, letting other real changes on the same record commit; reject_sync excludes the whole record', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.HRIS,
      provider: 'Workday',
      credentials: { accessToken: token },
      additionalConfig: { workdayApiBaseUrl: fakeApiBaseUrl },
    });
    createdConnectorIds.push(connector.id);

    for (const [source, target, rule] of [
      ['workerId', 'employeeNumber', undefined],
      ['organizationId', 'orgUnitId', undefined],
      ['employmentType', 'employmentType', { valueMap: { 'Full-Time': 'full_time', 'Part-Time': 'part_time' } }],
      ['fte', 'contractHoursPerWeek', { multiply: 40 }],
      ['hireDate', 'hireDate', undefined],
      ['costCenter', 'costCenter', undefined],
    ] as const) {
      await fieldMappings.upsert(tenantId, {
        connectorId: connector.id,
        sourceField: source,
        targetField: target,
        transformationRule: rule,
      });
    }

    // --- Sync 1: establish baseline employees, no policies yet. ---
    fixture = [
      {
        workerId: empFlagged,
        organizationId: orgUnitId,
        employmentType: 'Full-Time',
        fte: 1.0,
        hireDate: '2024-01-01',
        costCenter: 'CC-INITIAL',
      },
      {
        workerId: empRejected,
        organizationId: orgUnitId,
        employmentType: 'Full-Time',
        fte: 1.0,
        hireDate: '2024-01-01',
        costCenter: 'CC-INITIAL-2',
      },
    ];
    const baseline = await runSync(connector.id);
    expect(baseline.status).toBe(SyncJobStatus.COMPLETED);

    const beforeFlagged = await currentEmployeeRow(empFlagged);
    const beforeRejected = await currentEmployeeRow(empRejected);
    expect(beforeFlagged).toMatchObject({ cost_center: 'CC-INITIAL', employment_type: 'full_time' });
    expect(beforeRejected).toMatchObject({ cost_center: 'CC-INITIAL-2', employment_type: 'full_time' });

    // --- Configure policies: costCenter is agno_wfm-authoritative. ---
    await fieldAuthorityPolicies.upsert(tenantId, {
      connectorId: connector.id,
      fieldName: 'costCenter',
      authoritativeSource: FieldAuthoritySource.AGNO_WFM,
      conflictAction: FieldConflictAction.FLAG_FOR_REVIEW,
    });

    // --- Sync 2: both employees get a costCenter change (conflict) AND an employmentType change (no conflict). ---
    fixture = [
      {
        workerId: empFlagged,
        organizationId: orgUnitId,
        employmentType: 'Part-Time',
        fte: 0.5,
        hireDate: '2024-01-01',
        costCenter: 'CC-CHANGED',
      },
      {
        workerId: empRejected,
        organizationId: orgUnitId,
        employmentType: 'Part-Time',
        fte: 0.5,
        hireDate: '2024-01-01',
        costCenter: 'CC-CHANGED-2',
      },
    ];

    // empFlagged: flag_for_review (already configured above).
    const flaggedOutcome = await runSync(connector.id);
    expect(flaggedOutcome.status).toBe(SyncJobStatus.PARTIAL_FAILURE);
    expect(flaggedOutcome.recordsConflicted).toBeGreaterThanOrEqual(1);
    expect(flaggedOutcome.errorDetails).toMatchObject({
      fieldAuthorityConflicts: expect.arrayContaining([
        expect.objectContaining({
          employeeNumber: empFlagged,
          fieldName: 'costCenter',
          agnoValue: 'CC-INITIAL',
          incomingValue: 'CC-CHANGED',
        }),
      ]),
    });

    const afterFlagSync = await currentEmployeeRow(empFlagged);
    // costCenter reverted (Agno's own value wins), employmentType's real, non-conflicting change still committed.
    expect(afterFlagSync).toMatchObject({ cost_center: 'CC-INITIAL', employment_type: 'part_time' });

    const afterFlagSyncRejectedEmp = await currentEmployeeRow(empRejected);
    // No policy on this employee specifically excludes it, but the connector-wide costCenter policy
    // still applies to every record - it also got flagged/reverted here (policies are per connector+field, not per employee).
    expect(afterFlagSyncRejectedEmp).toMatchObject({ cost_center: 'CC-INITIAL-2', employment_type: 'part_time' });

    // --- Now switch the policy to reject_sync and prove a real, distinct behavior. ---
    await fieldAuthorityPolicies.upsert(tenantId, {
      connectorId: connector.id,
      fieldName: 'costCenter',
      authoritativeSource: FieldAuthoritySource.AGNO_WFM,
      conflictAction: FieldConflictAction.REJECT_SYNC,
    });
    fixture = [
      {
        workerId: empRejected,
        organizationId: orgUnitId,
        employmentType: 'Full-Time',
        fte: 1.0,
        hireDate: '2024-01-01',
        costCenter: 'CC-CHANGED-AGAIN',
      },
    ];
    const rejectOutcome = await runSync(connector.id);
    expect(rejectOutcome.status).toBe(SyncJobStatus.PARTIAL_FAILURE);
    expect(rejectOutcome.recordsFailed).toBeGreaterThanOrEqual(1);

    const afterRejectSync = await currentEmployeeRow(empRejected);
    // Whole record excluded - employmentType (a real, non-conflicting change back to full_time) did NOT commit either.
    expect(afterRejectSync).toMatchObject({ cost_center: 'CC-INITIAL-2', employment_type: 'part_time' });
  });

  it('§6: connector_type acd never creates a FieldAuthorityPolicy, and never accepts a FieldMapping.authority value', async () => {
    const { connector: acdConnector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.ACD,
      provider: 'Genesys Cloud',
      credentials: { apiKey: 'irrelevant-for-this-test' },
    });
    createdConnectorIds.push(acdConnector.id);

    await expect(
      fieldAuthorityPolicies.upsert(tenantId, {
        connectorId: acdConnector.id,
        fieldName: 'costCenter',
        authoritativeSource: FieldAuthoritySource.AGNO_WFM,
        conflictAction: FieldConflictAction.FLAG_FOR_REVIEW,
      }),
    ).rejects.toThrow(FieldAuthorityPolicyNotApplicableError);

    await expect(
      fieldMappings.upsert(tenantId, {
        connectorId: acdConnector.id,
        sourceField: 'agentId',
        targetField: 'employeeNumber',
        authority: FieldMappingAuthority.SOURCE_AUTHORITATIVE,
      }),
    ).rejects.toThrow(FieldMappingAuthorityNotApplicableError);

    // A mapping with no authority value at all is still fine for an acd connector (§2.2 rule 5 - nullable, not forbidden).
    const mapping = await fieldMappings.upsert(tenantId, {
      connectorId: acdConnector.id,
      sourceField: 'agentId',
      targetField: 'employeeNumber',
    });
    expect(mapping.authority).toBeNull();
  });
});
