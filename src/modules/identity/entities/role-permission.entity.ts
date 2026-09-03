import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * tenant_id here is denormalized and trigger-synced from the parent role
 * (ADR-0004) - never set it directly from application code, the DB trigger
 * (core.fn_sync_tenant_id_from_role) overwrites it on every insert/update.
 */
@Entity({ schema: 'core', name: 'role_permissions' })
export class RolePermission {
  @PrimaryColumn({ type: 'uuid', name: 'role_id' })
  roleId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'permission_id' })
  permissionId!: string;

  @Index('idx_role_permissions_tenant_id_role_id')
  @Column({ type: 'uuid', name: 'tenant_id', nullable: true })
  tenantId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
