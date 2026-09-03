import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum AnalyticsExportStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Phase 6 (§4.2/§1). `filter` is the same `MetricQueryFilter` shape
 * `metricQuery`/the live REST endpoint accept, jsonb-persisted so the
 * export job can re-derive exactly what was requested. `status`/`fileUri`
 * mirror Module 08's `ComplianceReport` shape (see the migration's own doc
 * comment for why this table has no retention/legal-hold columns).
 * Written/read via `withTenantConnection` (`agno_analytics_app`) - a
 * request-scoped table, not a cross-tenant batch job's output.
 */
@Entity({ name: 'analytics_export', schema: 'analytics' })
export class AnalyticsExport {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'requested_by' })
  requestedBy!: string;

  @Column('varchar', { name: 'metric_name' })
  metricName!: string;

  @Column('jsonb', { name: 'filter' })
  filter!: Record<string, unknown>;

  @Column('varchar', { name: 'status', default: AnalyticsExportStatus.PENDING })
  status!: AnalyticsExportStatus;

  @Column('text', { name: 'file_uri', nullable: true })
  fileUri!: string | null;

  @Column('integer', { name: 'row_count', nullable: true })
  rowCount!: number | null;

  @Column('text', { name: 'error_message', nullable: true })
  errorMessage!: string | null;

  @Column('varchar', { name: 'idempotency_key', nullable: true })
  idempotencyKey!: string | null;

  @Column('timestamptz', { name: 'requested_at' })
  requestedAt!: Date;

  @Column('timestamptz', { name: 'completed_at', nullable: true })
  completedAt!: Date | null;
}
