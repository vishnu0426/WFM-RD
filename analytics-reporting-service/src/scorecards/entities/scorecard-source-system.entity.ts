import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export enum ScorecardSourceSystemStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * Tenant Admin Integration Management, WP6. A tenant-registered external
 * QM/scorecard system (e.g. a NICE/Verint QM instance). `connectorId` is a
 * bare, optional cross-service reference to integration-hub-service's
 * `IntegrationConnector` - see this migration's own doc comment for why
 * it's not a real FK.
 */
@Entity({ name: 'scorecard_source_system', schema: 'analytics' })
export class ScorecardSourceSystem {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { length: 200 })
  name!: string;

  @Column('varchar', { length: 100 })
  provider!: string;

  @Column('uuid', { name: 'connector_id', nullable: true })
  connectorId!: string | null;

  @Column('varchar', { default: ScorecardSourceSystemStatus.ACTIVE })
  status!: ScorecardSourceSystemStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
