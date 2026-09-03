import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType('WorkingTimeCalendar')
export class WorkingTimeCalendarGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  orgUnitId!: string | null;

  @Field()
  countryCode!: string;

  @Field()
  timezone!: string;

  @Field(() => [String])
  holidayDates!: string[];

  @Field(() => Object)
  standardBusinessHours!: Record<string, unknown>;
}
