import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Tenant Admin Integration Management, WP6. A raw code/value catalog entry a `ScorecardSourceSystem` emits (e.g. a QM evaluation outcome code). */
@Entity({ name: 'scorecard_source_code', schema: 'analytics' })
export class ScorecardSourceCode {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'source_system_id' })
  sourceSystemId!: string;

  @Column('varchar', { length: 200 })
  code!: string;

  @Column('varchar', { length: 2000, nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
