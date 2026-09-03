import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Tenant Admin Integration Management, WP6. Maps a `ScorecardSourceMeasure`
 * onto a WFM-facing metric label. `targetMetric` is tenant-authored free
 * text, not an FK onto `MetricDefinition` - no canonical, tenant-agnostic
 * KPI catalog exists to map onto (confirmed by research; same treatment as
 * `ReasonCode.shiftOperation` in integration-hub-service's own WP3).
 */
@Entity({ name: 'scorecard_source_mapping', schema: 'analytics' })
export class ScorecardSourceMapping {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'source_measure_id' })
  sourceMeasureId!: string;

  @Column('varchar', { name: 'target_metric', length: 200 })
  targetMetric!: string;

  @Column('varchar', { length: 2000, nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
