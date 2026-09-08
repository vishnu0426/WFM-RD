import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * `PUT /v1/platform-settings/smtp` — partial update. `smtpPassword` follows
 * the same "omit to keep the current value" convention as
 * `UpdateEmailSettingsDto` (the tenant-level equivalent) — an omitted/
 * undefined field leaves the stored password untouched.
 */
export class UpdatePlatformSmtpSettingsDto {
  @IsOptional()
  @IsString()
  smtpHost?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  smtpPort?: number | null;

  @IsOptional()
  @IsString()
  smtpUsername?: string | null;

  @IsOptional()
  @IsString()
  smtpPassword?: string;

  @IsOptional()
  @IsEmail()
  smtpFromAddress?: string | null;

  @IsOptional()
  @IsBoolean()
  smtpUseTls?: boolean;
}
