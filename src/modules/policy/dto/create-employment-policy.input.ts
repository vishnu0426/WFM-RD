import { Field, InputType } from '@nestjs/graphql';
import { IsDateString, IsEnum, IsObject, IsOptional, IsUUID, Matches } from 'class-validator';
import { EmploymentPolicyType } from '../entities/employment-policy-type.enum';

/**
 * §3.1's `createEmploymentPolicy`. Supplying `policyGroupId` continues an
 * existing lineage (a new version, per ADR-0006) rather than starting a new
 * one - see `EmploymentPoliciesService.create` for the versioning mechanics.
 * `orgUnitId` omitted = tenant-wide (ADR-0012's existing convention).
 *
 * `jurisdiction` (ADR-0101): explicit, optional ISO country or
 * country-subdivision code (e.g. "US" or "US-CA") this policy is meant to
 * satisfy - used by the §0.6 compliance-floor validation gate. When
 * omitted and `orgUnitId` is set, `EmploymentPoliciesService.create` falls
 * back to that org unit's own `countryCode` - country-level precision
 * only, never state/subdivision (`OrgUnit` has no such field). When both
 * are omitted (a tenant-wide policy with no explicit jurisdiction), the
 * floor validation gate cannot run at all - there is no jurisdiction to
 * resolve a floor against.
 */
@InputType()
export class CreateEmploymentPolicyInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  policyGroupId?: string;

  @Field(() => EmploymentPolicyType)
  @IsEnum(EmploymentPolicyType)
  policyType!: EmploymentPolicyType;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Matches(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, {
    message: 'jurisdiction must be an ISO country or country-subdivision code, e.g. "US" or "US-CA".',
  })
  jurisdiction?: string;

  @Field(() => Object)
  @IsObject()
  definition!: Record<string, unknown>;

  @Field()
  @IsDateString()
  effectiveFrom!: string;
}
