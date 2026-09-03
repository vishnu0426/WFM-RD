import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType('WorkRule')
export class WorkRuleGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => Int, { nullable: true })
  maxConsecutiveDays!: number | null;

  @Field(() => Float, { nullable: true })
  minRestHours!: string | null;

  @Field(() => Float, { nullable: true })
  maxWeeklyHours!: string | null;

  @Field()
  otEligible!: boolean;

  @Field(() => Float, { nullable: true })
  minPaidHours!: string | null;

  @Field(() => Float, { nullable: true })
  maxOtPerDay!: string | null;

  @Field(() => Float, { nullable: true })
  maxOtPerWeek!: string | null;

  @Field(() => Float, { nullable: true })
  maxVtoPerDay!: string | null;

  @Field(() => Float, { nullable: true })
  maxVtoPerWeek!: string | null;

  @Field(() => Float, { nullable: true })
  requiredPayPeriodHours!: string | null;

  @Field(() => String, { nullable: true })
  effectiveFrom!: string | null;

  @Field(() => String, { nullable: true })
  effectiveTo!: string | null;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}
