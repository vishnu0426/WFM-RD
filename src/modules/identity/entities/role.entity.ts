import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { RoleStatus } from './role-status.enum';

/**
 * tenant_id is nullable = system-defined global role (§2.1). See the
 * migration's roles_system_role_tenant_consistency CHECK constraint, which
 * ties is_system_role and tenant_id together at the DB level.
 */
@Entity({ schema: 'core', name: 'roles' })
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'boolean', name: 'is_system_role', default: false })
  isSystemRole!: boolean;

  /** Frontend Phase 8 gap-fix (Roles Setup screen) - free-text description shown alongside the role name. */
  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Plain varchar + TS enum on top, matching this codebase's convention for simple enums (e.g. `User.status`/`UserStatus`), not a Postgres ENUM type. */
  @Column({ type: 'varchar', length: 20, default: RoleStatus.ACTIVE })
  status!: RoleStatus;

  /** Loosely-referenced org unit this role is scoped/displayed under - no FK, mirrors `UserRole.scopeOrgUnitId`'s bounded-context-by-design lack of a cross-module FK. */
  @Column({ type: 'uuid', name: 'organization_id', nullable: true })
  organizationId!: string | null;

  /** Whether newly created users get this role automatically. */
  @Column({ type: 'boolean', name: 'is_default', default: false })
  isDefault!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
