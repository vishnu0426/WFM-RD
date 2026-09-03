import { Entity, PrimaryColumn, Column, UpdateDateColumn, Index } from 'typeorm';
import { ProficiencyLevel } from './proficiency-level.enum';

/**
 * ADR-0010: partitioned `PARTITION BY HASH (tenant_id)` on the same modulus
 * as `Employee` so tenant-scoped joins against it colocate on the same
 * partition. `decay_score` is read by Module 04's OR-Tools solver as a
 * soft-constraint weight (§0.5 backward-compatibility note) - its scale
 * (0.0-1.0, 1.0 = freshest) and the nightly recomputation that maintains it
 * are Phase 4 scope; this phase only establishes the column and its
 * `[0,1]` DB-level CHECK constraint. `expiry_date` is trigger-computed from
 * `certified_date + skills.certification_validity_days` (Phase 1 migration)
 * rather than being settable directly - it is mapped here as a plain column
 * for reads, but the application never writes it.
 */
@Entity({ schema: 'org', name: 'employee_skills' })
@Index('idx_employee_skills_tenant_id_skill_id', ['tenantId', 'skillId'])
export class EmployeeSkill {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'skill_id' })
  skillId!: string;

  @Column({ type: 'varchar', length: 20, name: 'proficiency_level' })
  proficiencyLevel!: ProficiencyLevel;

  @Column({ type: 'date', name: 'certified_date', nullable: true })
  certifiedDate!: string | null;

  @Column({ type: 'date', name: 'expiry_date', nullable: true })
  expiryDate!: string | null;

  @Column({ type: 'numeric', precision: 4, scale: 3, name: 'decay_score', default: 1 })
  decayScore!: string;

  @Column({ type: 'timestamptz', name: 'last_scheduled_on_skill_at', nullable: true })
  lastScheduledOnSkillAt!: Date | null;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
