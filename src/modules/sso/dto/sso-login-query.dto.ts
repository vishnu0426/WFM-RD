import { IsIn, IsOptional, IsString } from 'class-validator';

/**
 * `GET /v1/auth/sso/login/:tenantIdpId` query params - the same
 * PKCE-carrying parameters `AuthorizeRequestDto` takes, minus
 * `response_type`/`client_id` duplication concerns (`client_id` still
 * required, resolved the same way `OAuthController.authorize` resolves it).
 * This is a real browser-facing redirect endpoint (unlike
 * `POST /oauth/authorize`, ADR-0026) - GET with query params is correct
 * here, not a simplification.
 */
export class SsoLoginQueryDto {
  @IsString()
  client_id!: string;

  @IsString()
  redirect_uri!: string;

  @IsString()
  code_challenge!: string;

  @IsIn(['S256'])
  code_challenge_method!: 'S256';

  @IsOptional()
  @IsString()
  scope?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  nonce?: string;
}
