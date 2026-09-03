import { Field, Float, InputType, Int, registerEnumType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Weekday } from '../entities/weekday.enum';
import { EarlyLate } from '../entities/early-late.enum';

registerEnumType(Weekday, { name: 'Weekday' });
registerEnumType(EarlyLate, { name: 'EarlyLate' });

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

@InputType()
export class SchedulePreferenceSlotInput {
  @Field(() => Int)
  @IsIn([1, 2, 3], { message: 'rank must be 1, 2, or 3' })
  rank!: 1 | 2 | 3;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'startTime must be HH:mm or HH:mm:ss' })
  startTime?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'endTime must be HH:mm or HH:mm:ss' })
  endTime?: string | null;

  @Field(() => EarlyLate, { nullable: true })
  @IsOptional()
  @IsEnum(EarlyLate)
  earlyLate?: EarlyLate | null;
}

@InputType()
export class UpsertEmployeeSchedulePreferenceInput {
  @Field(() => String)
  @IsUUID()
  employeeId!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'preferredShiftStart must be HH:mm or HH:mm:ss' })
  preferredShiftStart?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'preferredShiftEnd must be HH:mm or HH:mm:ss' })
  preferredShiftEnd?: string | null;

  @Field(() => [Weekday], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsEnum(Weekday, { each: true })
  preferredDaysOff?: Weekday[] | null;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0.1)
  @Max(168)
  maxWeeklyHours?: number | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  notes?: string | null;

  @Field(() => [SchedulePreferenceSlotInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => SchedulePreferenceSlotInput)
  preferenceSlots?: SchedulePreferenceSlotInput[] | null;
}
