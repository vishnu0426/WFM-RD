import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import { PermissionAction } from './permission-action.enum';

/** Global reference data, not tenant-scoped. resource is open-ended (e.g. "schedule",
 * "forecast", "leave_request") - new resources are added by later modules without
 * a Module 01 migration, so it stays a plain varchar rather than a CHECK-constrained set.
 */
@Entity({ schema: 'core', name: 'permissions' })
export class Permission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  resource!: string;

  @Column({ type: 'varchar', length: 20 })
  action!: PermissionAction;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
