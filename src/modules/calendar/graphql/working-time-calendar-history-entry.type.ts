import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';

/**
 * GAP-07 fix (enterprise readiness audit, 2026-08-18): the SCD Type 2 read
 * surface for `WorkingTimeCalendar` - same "backdated payroll dispute"
 * motivation `EmployeeHistoryEntryType`'s own doc comment names, now closed
 * for calendars too. Maps `WorkingTimeCalendarHistory` (trigger-written,
 * append-only) directly.
 */
@ObjectType('WorkingTimeCalendarHistoryEntry')
export class WorkingTimeCalendarHistoryEntryType {
  @Field(() => ID)
  id!: string;

  @Field(() => GraphQLISODateTime)
  validFrom!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  validTo!: Date | null;

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
