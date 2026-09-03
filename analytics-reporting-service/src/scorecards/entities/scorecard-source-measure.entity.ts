import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Tenant Admin Integration Management, WP6. One measure/metric a `ScorecardSourceSystem` exposes (e.g. "Quality Score", "Compliance %"). */
@Entity({ name: 'scorecard_source_measure', schema: 'analytics' })
export class ScorecardSourceMeasure {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'source_system_id' })
  sourceSystemId!: string;

  @Column('varchar', { length: 200 })
  code!: string;

  @Column('varchar', { length: 200 })
  name!: string;

  @Column('varchar', { length: 2000, nullable: true })
  description!: string | null;

  @Column('varchar', { length: 50, nullable: true })
  unit!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
