import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { InteractionType } from './interaction-type.enum';

/**
 * Manager/HR notes log. Originally append-only (`1700000023000`, no
 * UPDATE/DELETE grant, same posture as `core.audit_log`); `1700000028000`
 * granted UPDATE/DELETE so a note's `body` can be corrected in place and a
 * note can be hard-deleted - `employeeId`/`interactionType`/`createdBy`/
 * `createdAt` stay immutable by application-layer convention
 * (`EmployeeInteractionsService`), not by DB grant. No soft-delete column -
 * `deleteEmployeeInteraction` is a real `DELETE`.
 */
@Entity({ schema: 'org', name: 'employee_interactions' })
export class EmployeeInteraction {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @Column({ type: 'varchar', length: 30, name: 'interaction_type' })
  interactionType!: InteractionType;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'uuid', name: 'created_by', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
