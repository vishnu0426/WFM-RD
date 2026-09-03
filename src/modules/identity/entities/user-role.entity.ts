import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * tenant_id is denormalized (ADR-0004) and validated by a composite FK
 * (tenant_id, user_id) -> users(tenant_id, id) - see the Phase 1 migration.
 * scope_org_unit_id is an opaque reference to Module 02's OrgUnit.id
 * (NULL = tenant-wide scope); no cross-module FK by bounded-context design.
 * scope_group_id is the same idea for org.employee_groups.id - the two are
 * mutually exclusive (DB CHECK constraint, see UserRoleGroupScope
 * migration): a grant is tenant-wide (both null), org-unit-scoped, or
 * group-scoped, never more than one at once.
 */
@Entity({ schema: 'core', name: 'user_roles' })
@Index('idx_user_roles_tenant_id_user_id', ['tenantId', 'userId'])
@Index('idx_user_roles_tenant_id_role_id', ['tenantId', 'roleId'])
export class UserRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'role_id' })
  roleId!: string;

  @Column({ type: 'uuid', name: 'scope_org_unit_id', nullable: true })
  scopeOrgUnitId!: string | null;

  @Column({ type: 'uuid', name: 'scope_group_id', nullable: true })
  scopeGroupId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
