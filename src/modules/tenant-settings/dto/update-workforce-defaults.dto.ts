import { IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * `PUT /v1/tenant-settings/workforce-defaults` — partial update. Real,
 * validated, persisted — see `TenantSettings`' own doc comment on these
 * fields for exactly why they're not yet consumed by any scheduling/
 * forecasting/attendance computation (BACKEND GAP, disclosed, not implied).
 */
export class UpdateWorkforceDefaultsDto {
  @IsOptional()
  @IsIn([15, 30, 60])
  schedulingIntervalMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(52)
  planningPeriodWeeks?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(24)
  defaultShiftDurationHours?: number;

  @IsOptional()
  @IsIn([15, 30, 60])
  forecastingIntervalMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(104)
  historicalDataWindowWeeks?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(52)
  forecastingPlanningHorizonWeeks?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  attendanceGracePeriodMinutes?: number;
}
