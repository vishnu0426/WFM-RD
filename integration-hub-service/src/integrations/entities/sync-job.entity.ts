import { Column, Entity, PrimaryColumn } from 'typeorm';
import { SyncJobStatus } from './integration-connector.entity';

export enum SyncType {
  FULL = 'full',
  INCREMENTAL = 'incremental',
  STREAMING = 'streaming',
  /** WP5 (Historical Import/Backfill) - date-ranged, chunked (see `HistoricalBackfillChunk`), resumable. */
  HISTORICAL = 'historical',
}

/**
 * §2.1/§5c: for `syncType: STREAMING` (ACD connectors), this row represents
 * a relay connection/session window, not a discrete batch -
 * `startedAt`/`completedAt` are connection-established/closed,
 * `recordsProcessed`/`recordsFailed` are events forwarded/failed in the
 * window. `recordsConflicted` is structurally `NULL` for streaming rows
 * (enforced by this migration's own `CHECK`, §2.2 rule 5) since ACD
 * ingestion is one-directional and has nothing to conflict against.
 */
@Entity({ name: 'sync_job', schema: 'integration_hub' })
export class SyncJob {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'connector_id' })
  connectorId!: string;

  @Column('varchar', { name: 'sync_type' })
  syncType!: SyncType;

  @Column('varchar', { default: SyncJobStatus.QUEUED })
  status!: SyncJobStatus;

  @Column('integer', { name: 'records_processed', default: 0 })
  recordsProcessed!: number;

  @Column('integer', { name: 'records_failed', default: 0 })
  recordsFailed!: number;

  @Column('integer', { name: 'records_conflicted', nullable: true })
  recordsConflicted!: number | null;

  @Column('jsonb', { name: 'error_details', nullable: true })
  errorDetails!: Record<string, unknown> | null;

  @Column('timestamptz', { name: 'started_at' })
  startedAt!: Date;

  @Column('timestamptz', { name: 'completed_at', nullable: true })
  completedAt!: Date | null;

  /** §5a: set while this (still `RUNNING`) job is mid-retry in `withBackoffRetry`'s reactive backoff - never cleared explicitly, only ever meaningful while `status === RUNNING`. See migration `SyncJobRateLimitedUntil1700010200000`'s own doc comment. */
  @Column('timestamptz', { name: 'rate_limited_until', nullable: true })
  rateLimitedUntil!: Date | null;

  // ---------------------------------------------------------------------
  // WP5 (Historical Import/Backfill) - only meaningful/non-null for
  // `syncType: historical` rows (enforced by
  // `sync_job_historical_range_check`). See `HistoricalBackfillChunk` for
  // the per-chunk breakdown of a historical job's own date range.
  // ---------------------------------------------------------------------

  /** Which historical dataset this job imports - provider/adapter-defined, e.g. "call_volume_intervals". */
  @Column('varchar', { name: 'dataset_key', nullable: true })
  datasetKey!: string | null;

  @Column('date', { name: 'range_start', nullable: true })
  rangeStart!: string | null;

  @Column('date', { name: 'range_end', nullable: true })
  rangeEnd!: string | null;

  @Column('integer', { name: 'records_found', nullable: true })
  recordsFound!: number | null;

  @Column('integer', { name: 'records_duplicate', nullable: true })
  recordsDuplicate!: number | null;
}
