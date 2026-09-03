import { IsIn, IsOptional, IsString } from 'class-validator';
import { OAuthGrantType } from '../entities/oauth-grant-type.enum';

/**
 * RFC 6749 §4's token request, all three grants this phase supports folded
 * into one DTO (each grant needs a different subset of fields - see
 * `OAuthController.token`'s per-grant validation, which gives an RFC-correct
 * `invalid_request` rather than a generic 400 for a missing field). Field
 * names are snake_case - see `AuthorizeRequestDto`'s doc comment.
 */
export class TokenRequestDto {
  @IsIn(Object.values(OAuthGrantType))
  grant_type!: OAuthGrantType;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  redirect_uri?: string;

  @IsOptional()
  @IsString()
  code_verifier?: string;

  @IsOptional()
  @IsString()
  refresh_token?: string;

  @IsOptional()
  @IsString()
  client_id?: string;

  @IsOptional()
  @IsString()
  client_secret?: string;

  @IsOptional()
  @IsString()
  scope?: string;
}
