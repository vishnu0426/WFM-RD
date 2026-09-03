import { IsInt, IsOptional, IsString, IsUrl, Max, Min } from 'class-validator';

/** `PUT /v1/tenant-settings/general` — partial update. */
export class UpdateGeneralSettingsDto {
  @IsOptional()
  @IsUrl()
  brandLogoUrl?: string | null;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3650)
  dataRetentionDays?: number;
}
