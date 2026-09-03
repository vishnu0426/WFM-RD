import { Field, Float, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';

/**
 * "Time Banks" in the reference console's own menu — see `TimeBankEntry`'s
 * own doc comment (`../entities/time-bank-entry.entity.ts`) for the
 * signed-ledger design this maps directly.
 */
@ObjectType('TimeBankEntry')
export class TimeBankEntryType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  employeeId!: string;

  /** Positive = accrual, negative = draw-down. */
  @Field(() => Float)
  hours!: number;

  @Field()
  reason!: string;

  @Field(() => String)
  entryDate!: string;

  @Field(() => ID, { nullable: true })
  createdBy!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}
