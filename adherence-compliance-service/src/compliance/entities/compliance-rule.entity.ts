import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum ComplianceRuleType {
  OVERTIME_THRESHOLD = 'overtime_threshold',
  REST_PERIOD_MINIMUM = 'rest_period_minimum',
  MAX_CONSECUTIVE_DAYS = 'max_consecutive_days',
  BREAK_REQUIREMENT = 'break_requirement',
  UNION_RULE = 'union_rule',
}

export enum ComplianceRuleStatus {
  PENDING_REVIEW = 'pending_review',
  ACTIVE = 'active',
  SUPERSEDED = 'superseded',
  REJECTED = 'rejected',
}

/**
 * §0.6/§2.2 rule 3: the legal floor, platform-wide - no other module may
 * hardcode or independently define a labor-law threshold. `tenantId: null`
 * means "platform-default row for this jurisdiction," visible to (but not
 * writable as null by) every tenant - see this migration's own doc comment
 * and ADR-0095 for the RLS shape this implies. `status`/`activationDelayUntil`
 * are §5a's governance gate: `createComplianceRule` never writes `'active'`
 * directly, only `activateComplianceRule` does, and only after the admin has
 * reviewed a `RuleChangeImpactPreview`. Nothing in this phase writes or
 * reads this table yet - Phase 2 is CRUD + citation enforcement, Phase 4 is
 * the gRPC surface Module 02/04 actually call.
 */
@Entity({ name: 'compliance_rule', schema: 'compliance' })
export class ComplianceRule {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id', nullable: true })
  tenantId!: string | null;

  @Column('varchar', { name: 'jurisdiction' })
  jurisdiction!: string;

  @Column('varchar', { name: 'rule_type' })
  ruleType!: ComplianceRuleType;

  @Column('jsonb', { name: 'definition' })
  definition!: Record<string, unknown>;

  @Column('date', { name: 'effective_from' })
  effectiveFrom!: string;

  @Column('date', { name: 'effective_to', nullable: true })
  effectiveTo!: string | null;

  @Column('integer', { name: 'version', default: 1 })
  version!: number;

  @Column('text', { name: 'citation' })
  citation!: string;

  @Column('varchar', { name: 'status', default: ComplianceRuleStatus.PENDING_REVIEW })
  status!: ComplianceRuleStatus;

  @Column('timestamptz', { name: 'activation_delay_until', nullable: true })
  activationDelayUntil!: Date | null;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'activated_at', nullable: true })
  activatedAt!: Date | null;
}
