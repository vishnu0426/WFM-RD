import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { TenantTier } from './tenant-tier.enum';
import { TenantStatus } from './tenant-status.enum';

/**
 * Root tenant identity. Not RLS-protected (see the class-level comment in
 * the Phase 1 migration) - this table IS the tenant boundary, so per-row
 * isolation is enforced by application-layer authorization, not RLS.
 */
@Entity({ schema: 'core', name: 'tenants' })
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Index('idx_tenants_parent_tenant_id')
  @Column({ type: 'uuid', name: 'parent_tenant_id', nullable: true })
  parentTenantId!: string | null;

  @ManyToOne(() => Tenant, { nullable: true })
  @JoinColumn({ name: 'parent_tenant_id' })
  parentTenant?: Tenant | null;

  @Column({ type: 'varchar', length: 20 })
  tier!: TenantTier;

  @Column({ type: 'varchar', length: 50, name: 'data_residency_region' })
  dataResidencyRegion!: string;

  @Column({ type: 'varchar', length: 20, default: TenantStatus.PROVISIONING })
  status!: TenantStatus;

  /** Platform Admin onboarding's Company Information step - the only globally-unique (not per-tenant) identifier in this schema; see the migration's own doc comment. */
  @Column({ type: 'varchar', length: 63, nullable: true })
  slug!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  industry!: string | null;

  /** ISO 3166-1 alpha-2. */
  @Column({ type: 'varchar', length: 2, nullable: true })
  country!: string | null;

  /** ISO 4217 alpha-3. */
  @Column({ type: 'varchar', length: 3, nullable: true })
  currency!: string | null;

  /** BCP 47 language tag. */
  @Column({ type: 'varchar', length: 10, nullable: true })
  language!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
