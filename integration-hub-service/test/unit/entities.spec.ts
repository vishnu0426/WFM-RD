import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import {
  ConnectorStatus,
  ConnectorType,
  SyncJobStatus,
} from '../../src/integrations/entities/integration-connector.entity';
import { FieldMappingAuthority } from '../../src/integrations/entities/field-mapping.entity';
import { SyncType } from '../../src/integrations/entities/sync-job.entity';
import { WebhookSubscriptionStatus } from '../../src/integrations/entities/webhook-subscription.entity';
import {
  FieldAuthoritySource,
  FieldConflictAction,
} from '../../src/integrations/entities/field-authority-policy.entity';
import { entities } from '../../src/database/entities';

/**
 * Verifies the TypeORM entity classes agree with the §2.1 DDL and the
 * ADR-0003 enum-representation convention (a real TS enum backs every
 * varchar+CHECK column) - catches an entity/migration drift that a
 * TypeScript compile alone would not.
 */
describe('database entities', () => {
  it('registers all seven §2.1 entities, scoped to the integration_hub schema', () => {
    expect(entities).toHaveLength(7);
    const entitySet = new Set<unknown>(entities);
    const tables = getMetadataArgsStorage().tables.filter((t) => entitySet.has(t.target));
    expect(tables).toHaveLength(7);
    for (const table of tables) {
      expect(table.schema).toBe('integration_hub');
    }
  });

  it("ConnectorType matches §2.1's enum exactly", () => {
    expect(Object.values(ConnectorType).sort()).toEqual(['acd', 'crm', 'custom_webhook', 'hris', 'payroll'].sort());
  });

  it("ConnectorStatus matches §2.1's enum exactly", () => {
    expect(Object.values(ConnectorStatus).sort()).toEqual(['active', 'error', 'paused', 'pending_setup'].sort());
  });

  it("SyncJobStatus matches §2.1's enum exactly (shared by IntegrationConnector.lastSyncStatus and SyncJob.status)", () => {
    expect(Object.values(SyncJobStatus).sort()).toEqual(
      ['completed', 'failed', 'partial_failure', 'queued', 'running'].sort(),
    );
  });

  it("SyncType matches §2.1's enum exactly, including v2's streaming addition", () => {
    expect(Object.values(SyncType).sort()).toEqual(['full', 'incremental', 'streaming'].sort());
  });

  it("FieldMappingAuthority matches §5b's enum exactly", () => {
    expect(Object.values(FieldMappingAuthority).sort()).toEqual(
      ['agno_authoritative', 'manual_review', 'source_authoritative'].sort(),
    );
  });

  it("WebhookSubscriptionStatus matches §2.1's enum exactly", () => {
    expect(Object.values(WebhookSubscriptionStatus).sort()).toEqual(['active', 'disabled', 'failing'].sort());
  });

  it("FieldAuthoritySource matches §2.1's enum exactly", () => {
    expect(Object.values(FieldAuthoritySource).sort()).toEqual(['agno_wfm', 'external_system'].sort());
  });

  it("FieldConflictAction matches §2.1's enum exactly", () => {
    expect(Object.values(FieldConflictAction).sort()).toEqual(['flag_for_review', 'overwrite', 'reject_sync'].sort());
  });
});
