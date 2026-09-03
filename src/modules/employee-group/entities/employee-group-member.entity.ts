import { Entity, PrimaryColumn, CreateDateColumn } from 'typeorm';

/** Pure join row - membership is add/remove only, no updatable columns. */
@Entity({ schema: 'org', name: 'employee_group_members' })
export class EmployeeGroupMember {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'group_id' })
  groupId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'added_at' })
  addedAt!: Date;
}
