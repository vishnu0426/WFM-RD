import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Tenant Admin Integration Management, WP5 follow-up. One row per record a
 * `DatabaseHistoricalAdapter` chunk actually fetched from a tenant's
 * external database - the real "Raw Data" layer (spec §38). Deliberately
 * un-normalized (`rawData` is the query result row verbatim, jsonb) - see
 * this table's own migration doc comment for why normalization onto a
 * canonical WFM schema is a separate, still-open concern.
 */
@Entity({ name: 'historical_record', schema: 'integration_hub' })
export class HistoricalRecord {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'sync_job_id' })
  syncJobId!: string;

  @Column('uuid', { name: 'chunk_id' })
  chunkId!: string;

  @Column('jsonb', { name: 'raw_data' })
  rawData!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'fetched_at' })
  fetchedAt!: Date;
}
