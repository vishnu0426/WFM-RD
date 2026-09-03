import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { ProficiencyLevel } from './proficiency-level.enum';

/**
 * GAP-07 fix (enterprise readiness audit, 2026-08-18). ADR-0009 (SCD Type
 * 2) / same partitioning convention as `EmployeeHistory`. Written by
 * `org.fn_employee_skill_history_track` (`1700000018000`) on every INSERT
 * and on any UPDATE that changes `proficiency_level`, `certified_date`, or
 * `expiry_date` - never by application code (same append-only posture as
 * `EmployeeHistory`/`OrgUnitHistory`).
 */
@Entity({ schema: 'org', name: 'employee_skill_history' })
@Index('idx_employee_skill_history_tenant_employee_skill', ['tenantId', 'employeeId', 'skillId', 'validFrom'])
export class EmployeeSkillHistory {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @Column({ type: 'uuid', name: 'skill_id' })
  skillId!: string;

  @Column({ type: 'timestamptz', name: 'valid_from' })
  validFrom!: Date;

  /** NULL = this is the currently active version. */
  @Column({ type: 'timestamptz', name: 'valid_to', nullable: true })
  validTo!: Date | null;

  @Column({ type: 'varchar', length: 20, name: 'proficiency_level' })
  proficiencyLevel!: ProficiencyLevel;

  @Column({ type: 'date', name: 'certified_date', nullable: true })
  certifiedDate!: string | null;

  @Column({ type: 'date', name: 'expiry_date', nullable: true })
  expiryDate!: string | null;
}
