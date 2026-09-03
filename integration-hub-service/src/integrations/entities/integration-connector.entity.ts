import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum ConnectorType {
  HRIS = 'hris',
  PAYROLL = 'payroll',
  ACD = 'acd',
  CRM = 'crm',
  CUSTOM_WEBHOOK = 'custom_webhook',
}

export enum ConnectorStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  ERROR = 'error',
  PENDING_SETUP = 'pending_setup',
  /** Soft-delete terminal state (WP1, Tenant Admin Integration Management) - `agno_integration_hub_app` has no DELETE grant on this table by design (see the initial migration's own grants comment), so "Delete Data Source" transitions status here instead of removing the row. Excluded from default tenant-facing list views; retained for `SyncJob`/`FieldMapping`/`ReasonCode` history integrity. */
  DISABLED = 'disabled',
}

export enum SyncJobStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  PARTIAL_FAILURE = 'partial_failure',
}

/**
 * §1/§2.2 rule 1: `config` holds a Vault credential *reference key* only -
 * enforced at the write path in Phase 2 (ADR-0134), not by this entity or
 * this migration. Nothing in this phase's request path (there isn't one -
 * schema/migrations only) reads or writes `config` yet.
 */
@Entity({ name: 'integration_connector', schema: 'integration_hub' })
export class IntegrationConnector {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'connector_type' })
  connectorType!: ConnectorType;

  @Column('varchar')
  provider!: string;

  @Column('varchar', { default: ConnectorStatus.PENDING_SETUP })
  status!: ConnectorStatus;

  @Column('jsonb', { default: {} })
  config!: Record<string, unknown>;

  @Column('timestamptz', { name: 'last_sync_at', nullable: true })
  lastSyncAt!: Date | null;

  @Column('varchar', { name: 'last_sync_status', nullable: true })
  lastSyncStatus!: SyncJobStatus | null;
}
