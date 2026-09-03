import { IsEnum, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { AccrualFrequency } from '../entities/accrual-frequency.enum';

/** `POST /v1/accrual-policies` — User Management audit GAP-02's real accrual catalog. */
export class CreateAccrualPolicyDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsNumber()
  @Min(0)
  accrualRatePerPeriod!: number;

  @IsEnum(AccrualFrequency)
  accrualFrequency!: AccrualFrequency;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxBalanceCap?: number;
}
