import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { PolicyType } from './policy-type.enum';

/**
 * ADR-0006: policy_group_id is the stable lineage key across versions
 * ({policyId} in GET /v1/policies/{policyId}/history, Phase 6). The first
 * version of a logical policy sets policy_group_id = id.
 *
 * ADR-0012 (Module 02): `orgUnitId` is an additive, nullable column reused
 * by `EmploymentPolicy` (Module 02 §2.1) to scope a policy below the tenant
 * (`NULL` = tenant-wide, matching every other `Policy` row). Deliberately an
 * opaque uuid with no FK to `org.org_units` - same "no cross-module FK by
 * design" bounded-context choice already made for
 * `UserRole.scope_org_unit_id`.
 */
@Entity({ schema: 'core', name: 'policies' })
@Index('idx_policies_tenant_id_group_id', ['tenantId', 'policyGroupId'])
@Index('idx_policies_tenant_id_type', ['tenantId', 'policyType'])
@Index('idx_policies_tenant_id_org_unit_id', ['tenantId', 'orgUnitId'])
export class Policy {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'policy_group_id' })
  policyGroupId!: string;

  @Column({ type: 'varchar', length: 30, name: 'policy_type' })
  policyType!: PolicyType;

  /** NULL = tenant-wide (every Module 01 policy type); non-null = scoped to that org unit (Module 02 EmploymentPolicy). */
  @Column({ type: 'uuid', name: 'org_unit_id', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'jsonb' })
  definition!: Record<string, unknown>;

  @Column({ type: 'timestamptz', name: 'effective_from' })
  effectiveFrom!: Date;

  @Column({ type: 'timestamptz', name: 'effective_to', nullable: true })
  effectiveTo!: Date | null;

  @Column({ type: 'int' })
  version!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
