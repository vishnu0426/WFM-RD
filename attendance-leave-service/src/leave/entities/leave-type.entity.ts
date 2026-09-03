import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §5.2, ADR-0073: `carryoverRules` is tenant-configurable jsonb
 * (`{ maxCarryoverDays, carryoverExpiryMonths }`), the platform-wide
 * policy-as-data pattern (same shape as core `Policy.definition`, ADR-0003's
 * §2.1 rule 4 precedent) - not a hardcoded constant, and present from this
 * phase's migration rather than retrofitted once Phase 7 builds the
 * rollover job that reads it. `accrualPolicyId` is a plain cross-schema
 * uuid pointing at Module 02's `EmploymentPolicy` (ADR-0052 discipline) -
 * referential correctness for that link is a gRPC-contract concern, not
 * Postgres's.
 */
@Entity({ name: 'leave_type', schema: 'attendance_leave' })
export class LeaveType {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar')
  name!: string;

  @Column('uuid', { name: 'accrual_policy_id' })
  accrualPolicyId!: string;

  @Column('boolean', { name: 'requires_approval', default: true })
  requiresApproval!: boolean;

  @Column('boolean', { name: 'requires_documentation', default: false })
  requiresDocumentation!: boolean;

  @Column('integer', { name: 'max_consecutive_days', nullable: true })
  maxConsecutiveDays!: number | null;

  @Column('jsonb', { name: 'carryover_rules', default: {} })
  carryoverRules!: Record<string, unknown>;
}
