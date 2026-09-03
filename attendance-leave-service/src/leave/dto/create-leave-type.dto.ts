import { IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';

/** `POST /v1/leave-types` — User Management "Time Off" screen gap-fix: `LeaveType` previously had no CRUD surface at all in this service (seed/read-only). */
export class CreateLeaveTypeDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsUUID()
  accrualPolicyId!: string;

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
