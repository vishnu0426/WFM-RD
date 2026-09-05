import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum ConnectorType {
  HRIS = 'hris',
  PAYROLL = 'payroll',
  ACD = 'acd',
  CRM = 'crm',
  CUSTOM_WEBHOOK = 'custom_webhook',
  /** Historical Data (WP5 follow-up): a tenant-owned external SQL database, pulled from directly rather than through a vendor API - see `DatabaseHistoricalAdapter`. Not batch/streaming (isBatchConnectorType/isStreamingConnectorType both correctly return false for it); reached only through the historical-import path. */
  DATABASE = 'database',
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
  /** WP5 (Historical Import/Backfill) only - `sync_job.status` alone widened to allow this (see migration `HistoricalBackfill1700010500000`); `integration_connector.last_sync_status` still only accepts the original five values, and nothing ever writes CANCELLED there. */
  CANCELLED = 'cancelled',
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
