import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * `PUT /v1/tenant-settings/email` — partial update. `smtpPassword` follows
 * the same "omit to keep the current value" convention already used for
 * `oidcClientSecret` (`IdentityProviderFormDialog`'s frontend precedent):
 * an omitted/undefined field leaves the stored password untouched, only a
 * non-empty string overwrites it. There is no way to clear the password
 * back to unset via this endpoint — that's a deliberate limitation, not a
 * gap: a tenant intentionally clearing SMTP credentials would do so by
 * clearing `smtpHost` too, which more accurately reflects "email isn't
 * configured."
 */
export class UpdateEmailSettingsDto {
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
