import { IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';

/** `PATCH /v1/leave-types/:id` — every field optional; a field simply absent from the request body is left untouched. */
export class UpdateLeaveTypeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsUUID()
  accrualPolicyId?: string;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresDocumentation?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxConsecutiveDays?: number;

  @IsOptional()
  @IsObject()
  carryoverRules?: Record<string, unknown>;
}
