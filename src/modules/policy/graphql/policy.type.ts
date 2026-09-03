import { Field, ID, Int, ObjectType, GraphQLISODateTime, registerEnumType } from '@nestjs/graphql';
import { PolicyType } from '../entities/policy-type.enum';

registerEnumType(PolicyType, { name: 'PolicyType' });

/**
 * Phase 6 GraphQL BFF (ADR-0045) - read-only mirror of `core.policies`,
 * distinct from `EmploymentPolicyGraphQLType` (Module 02's narrower,
 * org-unit-scoped-only view over the same table - see that type's doc
 * comment) - this one exposes every `PolicyType`, tenant-wide and
 * org-unit-scoped alike, matching `GET /v1/policies/{policyId}/history`'s
 * REST scope.
 */
@ObjectType('Policy')
export class PolicyGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  policyGroupId!: string;

  @Field(() => PolicyType)
  policyType!: PolicyType;

  @Field(() => String, { nullable: true })
  orgUnitId!: string | null;

  @Field(() => Object)
  definition!: Record<string, unknown>;

  @Field(() => GraphQLISODateTime)
  effectiveFrom!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  effectiveTo!: Date | null;

  @Field(() => Int)
  version!: number;
}
