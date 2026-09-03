import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { Weekday } from '../entities/weekday.enum';
import { EarlyLate } from '../entities/early-late.enum';

@ObjectType('SchedulePreferenceSlot')
export class SchedulePreferenceSlotGraphQLType {
  @Field(() => Int)
  rank!: number;

  @Field(() => String, { nullable: true })
  startTime!: string | null;

  @Field(() => String, { nullable: true })
  endTime!: string | null;

  @Field(() => EarlyLate, { nullable: true })
  earlyLate!: EarlyLate | null;
}

@ObjectType('EmployeeSchedulePreference')
export class EmployeeSchedulePreferenceGraphQLType {
  @Field(() => ID)
  employeeId!: string;

  @Field(() => String, { nullable: true })
  preferredShiftStart!: string | null;

  @Field(() => String, { nullable: true })
  preferredShiftEnd!: string | null;

  @Field(() => [Weekday], { nullable: true })
  preferredDaysOff!: Weekday[] | null;

  @Field(() => Float, { nullable: true })
  maxWeeklyHours!: string | null;

  @Field(() => String, { nullable: true })
  notes!: string | null;

  @Field(() => [SchedulePreferenceSlotGraphQLType], { nullable: true })
  preferenceSlots!: SchedulePreferenceSlotGraphQLType[] | null;

  @Field()
  updatedAt!: Date;

  @Field(() => String, { nullable: true })
  updatedBy!: string | null;
}
