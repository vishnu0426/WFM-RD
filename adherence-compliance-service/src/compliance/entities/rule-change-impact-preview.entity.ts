import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §5a - a new entity closing the source spec's flagged governance gap, not
 * in §2.1's literal list. `tenantId` is added beyond §5a's own field list
 * because every table in this schema is RLS-scoped (this platform's
 * universal convention) - `complianceRuleId` already scopes a preview to
 * one rule, but the plain tenant_id column is still required for RLS to
 * apply here like everywhere else. `simulatedAgainstScheduleIds`/
 * `affectedEmployeeIds`/`affectedOrgUnitIds` are jsonb arrays rather than
 * Postgres native arrays or a normalized join table - this platform's
 * established idiom for a variable-length id list on a row that is itself
 * write-once (attendance-leave's `LeaveRequest.conflictFlags` is the same
 * shape for the same reason). Computed by re-running the relevant
 * constraint check against currently-published schedules (§5a) - real logic
 * lands in Phase 5, not this phase.
 */
@Entity({ name: 'rule_change_impact_preview', schema: 'compliance' })
export class RuleChangeImpactPreview {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'compliance_rule_id' })
  complianceRuleId!: string;

  @Column('jsonb', { name: 'simulated_against_schedule_ids', default: [] })
  simulatedAgainstScheduleIds!: string[];

  @Column('integer', { name: 'would_become_noncompliant_count', default: 0 })
  wouldBecomeNoncompliantCount!: number;

  @Column('jsonb', { name: 'affected_employee_ids', default: [] })
  affectedEmployeeIds!: string[];

  @Column('jsonb', { name: 'affected_org_unit_ids', default: [] })
  affectedOrgUnitIds!: string[];

  @Column('timestamptz', { name: 'generated_at' })
  generatedAt!: Date;
}
