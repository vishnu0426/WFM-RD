import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { AssigneeType } from './assignee-type.enum';

/**
 * `assigneeId` is polymorphic (`org.employees.id` when `assigneeType =
 * 'employee'`, `org.employee_groups.id` when `'group'`) - no DB-level FK,
 * validated in `WorkRulesService.assign` instead (migration's own doc comment).
 */
@Entity({ schema: 'org', name: 'work_rule_assignments' })
export class WorkRuleAssignment {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'work_rule_id' })
  workRuleId!: string;

  @PrimaryColumn({ type: 'varchar', length: 20, name: 'assignee_type' })
  assigneeType!: AssigneeType;

  @PrimaryColumn({ type: 'uuid', name: 'assignee_id' })
  assigneeId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'assigned_at' })
  assignedAt!: Date;

  /** Closes the User Management audit's GAP-05: real conflict-resolution when an employee is covered by more than one binding — higher wins. */
  @Column({ type: 'integer', default: 0 })
  priority!: number;

  @Column({ type: 'date', name: 'effective_from', nullable: true })
  effectiveFrom!: string | null;

  @Column({ type: 'date', name: 'effective_to', nullable: true })
  effectiveTo!: string | null;
}
