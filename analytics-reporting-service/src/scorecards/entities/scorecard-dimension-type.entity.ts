import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Tenant Admin Integration Management, WP6. A tenant-defined scorecard dimension category (e.g. "Team", "Site", "Skill"). */
@Entity({ name: 'scorecard_dimension_type', schema: 'analytics' })
export class ScorecardDimensionType {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { length: 200 })
  name!: string;

  @Column('varchar', { length: 2000, nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
