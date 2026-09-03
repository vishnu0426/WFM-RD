import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/** `PUT /v1/tenant-settings/security` — partial update. */
export class UpdateSecurityPolicyDto {
  @IsOptional()
  @IsInt()
  @Min(8)
  @Max(128)
  passwordMinLength?: number;

  @IsOptional()
  @IsBoolean()
  passwordRequireUppercase?: boolean;

  @IsOptional()
  @IsBoolean()
  passwordRequireNumber?: boolean;

  @IsOptional()
  @IsBoolean()
  passwordRequireSymbol?: boolean;

  /** `null` = passwords never expire. */
  @IsOptional()
  @IsInt()
  @Min(1)
  passwordExpiryDays?: number | null;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  sessionTimeoutMinutes?: number;

  @IsOptional()
  @IsBoolean()
  mfaRequired?: boolean;
}
