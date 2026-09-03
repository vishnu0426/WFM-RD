import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { EmploymentType } from './employment-type.enum';
import { EmployeeStatus } from './employee-status.enum';

/**
 * ADR-0009 (SCD Type 2) / ADR-0010 (partitioning). Written by
 * `org.fn_employee_history_track` on every INSERT and on any UPDATE that
 * changes `org_unit_id`, `manager_employee_id`, or `status` (§2.3) - never
 * by application code (same append-only posture as `OrgUnitHistory`).
 * Partitioned `PARTITION BY HASH (tenant_id)` with the same modulus as
 * `Employee` so a tenant's history rows colocate with its live rows.
 */
@Entity({ schema: 'org', name: 'employee_history' })
@Index('idx_employee_history_tenant_id_employee_id', ['tenantId', 'employeeId', 'validFrom'])
export class EmployeeHistory {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @Column({ type: 'timestamptz', name: 'valid_from' })
  validFrom!: Date;

  /** NULL = this is the currently active version. */
  @Column({ type: 'timestamptz', name: 'valid_to', nullable: true })
  validTo!: Date | null;

  @Column({ type: 'uuid', name: 'org_unit_id' })
  orgUnitId!: string;

  @Column({ type: 'varchar', length: 50, name: 'employee_number' })
  employeeNumber!: string;

  @Column({ type: 'varchar', length: 20, name: 'employment_type' })
  employmentType!: EmploymentType;

  @Column({ type: 'numeric', precision: 5, scale: 2, name: 'contract_hours_per_week' })
  contractHoursPerWeek!: string;

  @Column({ type: 'varchar', length: 100, name: 'cost_center', nullable: true })
  costCenter!: string | null;

  @Column({ type: 'uuid', name: 'manager_employee_id', nullable: true })
  managerEmployeeId!: string | null;

  @Column({ type: 'varchar', length: 30 })
  status!: EmployeeStatus;
}
