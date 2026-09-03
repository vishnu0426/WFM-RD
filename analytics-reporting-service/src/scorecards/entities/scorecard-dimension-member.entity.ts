import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Tenant Admin Integration Management, WP6. One member/value under a `ScorecardDimensionType` (e.g. "Team Alpha" under "Team"). */
@Entity({ name: 'scorecard_dimension_member', schema: 'analytics' })
export class ScorecardDimensionMember {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'dimension_type_id' })
  dimensionTypeId!: string;

  @Column('varchar', { length: 200 })
  code!: string;

  @Column('varchar', { length: 200 })
  name!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
