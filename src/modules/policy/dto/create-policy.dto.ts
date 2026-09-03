import { IsDateString, IsIn, IsObject, IsOptional, IsUUID } from 'class-validator';
import { PolicyType } from '../entities/policy-type.enum';

/**
 * §3.2's `POST /v1/policies` - "Create/version a policy definition."
 * `policyGroupId` present = version an existing lineage (ADR-0006);
 * absent = start a new one. `effectiveFrom` defaults to now if omitted.
 */
export class CreatePolicyDto {
  @IsOptional()
  @IsUUID()
  policyGroupId?: string;

  @IsIn(Object.values(PolicyType))
  policyType!: PolicyType;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @IsObject()
  definition!: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
