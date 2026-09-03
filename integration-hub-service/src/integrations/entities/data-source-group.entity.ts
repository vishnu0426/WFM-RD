import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Tenant Admin Integration Management, WP3 (plan decision #4). A real
 * aggregation layer above `forecasting-service.CcQueue` (each `CcQueue` row
 * is one queue; a group bundles several under one tenant-facing name with
 * its own `avgWorkTimeSeconds`, the field the spec requires that no
 * existing entity carries). Membership lives in the sibling
 * `data-source-group-queue.entity.ts` join table.
 */
@Entity({ name: 'data_source_group', schema: 'integration_hub' })
export class DataSourceGroup {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'data_source_id' })
  dataSourceId!: string;

  @Column('varchar', { length: 200 })
  name!: string;

  @Column('varchar', { length: 2000, nullable: true })
  description!: string | null;

  /** Tenant-authored free text (e.g. "Skill Group", "Split") - no canonical group-type enum exists in this domain. */
  @Column('varchar', { length: 100, nullable: true })
  type!: string | null;

  @Column('integer', { name: 'avg_work_time_seconds', nullable: true })
  avgWorkTimeSeconds!: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
