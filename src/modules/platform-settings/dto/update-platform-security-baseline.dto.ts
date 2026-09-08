import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * `PUT /v1/platform-settings/security-baseline` — partial update. Each
 * field is a floor/ceiling every tenant's own `TenantSettings` security
 * policy must respect (enforced in
 * `PlatformSecurityBaselineService.assertWithinBaseline`, called from
 * `TenantSettingsService.updateSecurityPolicy`), not a value for one
 * tenant. `null` clears a floor/ceiling back to "no restriction."
 */
export class UpdatePlatformSecurityBaselineDto {
  @IsOptional()
  @IsInt()
  @Min(8)
  @Max(128)
  passwordMinLengthFloor?: number | null;

  @IsOptional()
  @IsBoolean()
  passwordRequireUppercase?: boolean;

  @IsOptional()
  @IsBoolean()
  passwordRequireNumber?: boolean;

  @IsOptional()
  @IsBoolean()
  passwordRequireSymbol?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  passwordExpiryDaysCeiling?: number | null;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  sessionTimeoutCeilingMinutes?: number | null;

  @IsOptional()
  @IsBoolean()
  mfaRequired?: boolean;
}
