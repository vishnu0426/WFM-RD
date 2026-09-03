import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { EmployeeGroupStatus } from './employee-group-status.enum';

/**
 * Unpartitioned, same shape as `org.skills` - a tenant has orders of
 * magnitude fewer groups than employees.
 *
 * `organizationId`/`parentGroupId` (`1700000028000`) are deliberately
 * unconstrained at the DB level - no FK - same loose-reference trade-off
 * this schema already accepts for `UserRole.scopeOrgUnitId`: `organizationId`
 * is a forward-looking multi-org hook (no `core.organizations` table exists
 * yet to reference), and `parentGroupId` is a self-reference for a
 * lightweight group hierarchy, validated (if at all) at the application
 * layer rather than by a composite FK.
 */
@Entity({ schema: 'org', name: 'employee_groups' })
export class EmployeeGroup {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'uuid', name: 'organization_id', nullable: true })
  organizationId!: string | null;

  @Column({ type: 'uuid', name: 'parent_group_id', nullable: true })
  parentGroupId!: string | null;

  @Column({ type: 'varchar', length: 20, default: EmployeeGroupStatus.ACTIVE })
  status!: EmployeeGroupStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
