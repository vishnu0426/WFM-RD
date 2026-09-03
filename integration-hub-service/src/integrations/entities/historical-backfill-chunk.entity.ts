import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum HistoricalBackfillChunkStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * Tenant Admin Integration Management, WP5 (plan decision #6). One row per
 * date-range chunk of a parent `syncType: historical` `SyncJob` - the
 * chunking/checkpointing the spec's Historical Backfill requires. A failed
 * job resumes from its first non-completed chunk
 * (`HistoricalBackfillRunnerService.resume`), not from the start of the
 * whole range.
 */
@Entity({ name: 'historical_backfill_chunk', schema: 'integration_hub' })
export class HistoricalBackfillChunk {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'sync_job_id' })
  syncJobId!: string;

  @Column('integer', { name: 'chunk_index' })
  chunkIndex!: number;

  @Column('date', { name: 'range_start' })
  rangeStart!: string;

  @Column('date', { name: 'range_end' })
  rangeEnd!: string;

  @Column('varchar', { default: HistoricalBackfillChunkStatus.QUEUED })
  status!: HistoricalBackfillChunkStatus;

  /** Provider/adapter-defined resume cursor (e.g. a page token or last-processed-record id) - opaque to this table, meaningful only to the adapter that wrote it. */
  @Column('jsonb', { name: 'checkpoint_cursor', nullable: true })
  checkpointCursor!: Record<string, unknown> | null;

  @Column('integer', { name: 'records_found', default: 0 })
  recordsFound!: number;

  @Column('integer', { name: 'records_processed', default: 0 })
  recordsProcessed!: number;

  @Column('integer', { name: 'records_failed', default: 0 })
  recordsFailed!: number;

  @Column('integer', { name: 'records_duplicate', default: 0 })
  recordsDuplicate!: number;

  @Column('jsonb', { name: 'error_details', nullable: true })
  errorDetails!: Record<string, unknown> | null;

  @Column('timestamptz', { name: 'started_at', nullable: true })
  startedAt!: Date | null;

  @Column('timestamptz', { name: 'completed_at', nullable: true })
  completedAt!: Date | null;
}
