import { Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsDateString, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, Matches } from 'class-validator';
import { ComplianceRule, ComplianceRuleType } from './entities/compliance-rule.entity';
import { RuleChangeImpactPreview } from './entities/rule-change-impact-preview.entity';

registerEnumType(ComplianceRuleType, {
  name: 'ComplianceRuleType',
  description: "§2.1's fixed rule-type vocabulary - the same enum this module's schema CHECK constraint enforces.",
});

/** §2.1/§3.1 - co-located with the domain, same convention as shift-marketplace-service's own `src/marketplace/types.ts`. */
@ObjectType('ComplianceRule')
export class ComplianceRuleResult {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  jurisdiction!: string;

  @Field(() => ComplianceRuleType)
  ruleType!: ComplianceRuleType;

  @Field(() => Object)
  definition!: Record<string, unknown>;

  /** `YYYY-MM-DD` - a `date` column, not a timestamp; no time-of-day component, same convention as attendance-leave's `LeaveRequest.dateRangeStart`. */
  @Field(() => String)
  effectiveFrom!: string;

  @Field(() => String, { nullable: true })
  effectiveTo!: string | null;

  @Field(() => Int)
  version!: number;

  @Field(() => String)
  citation!: string;

  @Field(() => String)
  status!: string;

  @Field(() => Date, { nullable: true })
  activationDelayUntil!: Date | null;

  /** True for a platform-default row (`tenantId === null`, §2.2 rule 3) - exposed as a boolean rather than the raw (usually-null) `tenantId`, since a client never needs the literal id, only "is this mine or the platform's." */
  @Field(() => Boolean)
  isPlatformDefault!: boolean;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date, { nullable: true })
  activatedAt!: Date | null;
}

export function toComplianceRuleResult(rule: ComplianceRule): ComplianceRuleResult {
  return {
    id: rule.id,
    jurisdiction: rule.jurisdiction,
    ruleType: rule.ruleType,
    definition: rule.definition,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    version: rule.version,
    citation: rule.citation,
    status: rule.status,
    activationDelayUntil: rule.activationDelayUntil,
    isPlatformDefault: rule.tenantId === null,
    createdAt: rule.createdAt,
    activatedAt: rule.activatedAt,
  };
}

/**
 * §3.1's `createComplianceRule` input. Decorated with both `@InputType()`
 * (GraphQL) and `class-validator` decorators on the same class, rather than
 * two parallel classes - this is this service's first GraphQL input type
 * needing validation (every existing mutation in this platform's other
 * GraphQL services takes bare scalar args), and a single source of truth
 * for "what a valid input looks like" is preferable to keeping a DTO and an
 * `@InputType()` in sync by hand. `ValidationPipe` (already global,
 * `main.ts`) applies to resolver arguments the same way it applies to REST
 * bodies.
 *
 * Always creates a **tenant-scoped** rule - there is no way to request a
 * platform-default (`tenantId: null`) row through this input at all
 * (ADR-0097): platform defaults are seeded out of band, never through this
 * mutation.
 */
@InputType()
export class CreateComplianceRuleInput {
  @Field(() => String)
  @IsString()
  @Matches(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, {
    message: 'jurisdiction must be an ISO country or country-subdivision code, e.g. "US" or "US-CA".',
  })
  jurisdiction!: string;

  @Field(() => ComplianceRuleType)
  @IsEnum(ComplianceRuleType)
  ruleType!: ComplianceRuleType;

  @Field(() => Object)
  @IsObject()
  definition!: Record<string, unknown>;

  @Field(() => String)
  @IsDateString({ strict: true })
  effectiveFrom!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString({ strict: true })
  effectiveTo?: string;

  /** §2.2 rule 2: mandatory and non-empty - enforced here (application layer), and again, structurally, by the schema's `compliance_rule_citation_required_check`. */
  @Field(() => String)
  @IsString()
  @IsNotEmpty()
  citation!: string;
}

/** §5a/docs/adr/0104: `generateRuleChangeImpactPreview`'s result - a plain read model over the persisted entity, same "co-located ObjectType" convention as `ComplianceRuleResult`. */
@ObjectType('RuleChangeImpactPreview')
export class RuleChangeImpactPreviewResult {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  complianceRuleId!: string;

  @Field(() => [ID])
  simulatedAgainstScheduleIds!: string[];

  @Field(() => Int)
  wouldBecomeNoncompliantCount!: number;

  @Field(() => [ID])
  affectedEmployeeIds!: string[];

  @Field(() => [ID])
  affectedOrgUnitIds!: string[];

  @Field(() => Date)
  generatedAt!: Date;
}

export function toRuleChangeImpactPreviewResult(preview: RuleChangeImpactPreview): RuleChangeImpactPreviewResult {
  return {
    id: preview.id,
    complianceRuleId: preview.complianceRuleId,
    simulatedAgainstScheduleIds: preview.simulatedAgainstScheduleIds,
    wouldBecomeNoncompliantCount: preview.wouldBecomeNoncompliantCount,
    affectedEmployeeIds: preview.affectedEmployeeIds,
    affectedOrgUnitIds: preview.affectedOrgUnitIds,
    generatedAt: preview.generatedAt,
  };
}
