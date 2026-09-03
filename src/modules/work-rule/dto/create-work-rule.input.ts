import { Field, Float, InputType, Int } from '@nestjs/graphql';
import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

@InputType()
export class CreateWorkRuleInput {
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxConsecutiveDays?: number | null;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  minRestHours?: number | null;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0.1)
  @Max(168)
  maxWeeklyHours?: number | null;

  @Field(() => Boolean, { nullable: true, defaultValue: true })
  @IsOptional()
  @IsBoolean()
  otEligible?: boolean;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  minPaidHours?: number | null;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  maxOtPerDay?: number | null;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  maxOtPerWeek?: number | null;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  maxVtoPerDay?: number | null;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  maxVtoPerWeek?: number | null;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  requiredPayPeriodHours?: number | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;
}
