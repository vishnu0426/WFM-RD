import { IsEnum, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { AccrualFrequency } from '../entities/accrual-frequency.enum';
import { AccrualPolicyStatus } from '../entities/accrual-policy-status.enum';

/** `PATCH /v1/accrual-policies/:id` */
export class UpdateAccrualPolicyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  accrualRatePerPeriod?: number;

  @IsOptional()
  @IsEnum(AccrualFrequency)
  accrualFrequency?: AccrualFrequency;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxBalanceCap?: number | null;

  @IsOptional()
  @IsEnum(AccrualPolicyStatus)
  status?: AccrualPolicyStatus;
}
