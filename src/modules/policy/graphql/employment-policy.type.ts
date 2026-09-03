import { Field, ID, Int, ObjectType, registerEnumType, GraphQLISODateTime } from '@nestjs/graphql';
import { EmploymentPolicyType } from '../entities/employment-policy-type.enum';

registerEnumType(EmploymentPolicyType, { name: 'EmploymentPolicyType' });

/** §2.1's `EmploymentPolicy`, backed by `core.policies` (ADR-0012) - not a distinct table. */
@ObjectType('EmploymentPolicy')
export class EmploymentPolicyGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  policyGroupId!: string;

  @Field(() => EmploymentPolicyType)
  policyType!: EmploymentPolicyType;

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
