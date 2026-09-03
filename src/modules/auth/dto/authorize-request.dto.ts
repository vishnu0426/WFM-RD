import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * RFC 6749 §4.1.1 + RFC 7636 §4.3 wire format - field names are snake_case
 * because that is the mandated OAuth request shape, not a stylistic choice
 * (every other DTO in this repo camelCases GraphQL input fields; this one
 * deliberately doesn't). See ADR-0026: this endpoint combines resource-owner
 * authentication with code issuance in one call since this repo has no
 * hosted login UI - `username`/`password` are not part of RFC 6749's
 * `/authorize` request in a real deployment with a browser-rendered login
 * page.
 *
 * Phase 3 (§5.4) adds a second, mutually exclusive credential shape:
 * `webauthn_session_token` in place of `username`/`password`, issued by
 * `POST /webauthn/authenticate/verify` after a successful passkey assertion
 * - see `WebAuthnSessionService`. `OAuthController.authorize` requires
 * exactly one of the two shapes; DTO-level validation can't express "either
 * username+password or webauthn_session_token" declaratively without a
 * union type class-validator doesn't support cleanly, so that check is a
 * plain runtime guard in the controller (see its own doc comment).
 */
export class AuthorizeRequestDto {
  @IsString()
  client_id!: string;

  @IsString()
  redirect_uri!: string;

  @IsIn(['code'])
  response_type!: 'code';

  @IsOptional()
  @IsString()
  scope?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsString()
  code_challenge!: string;

  @IsIn(['S256'])
  code_challenge_method!: 'S256';

  @IsOptional()
  @IsString()
  nonce?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  password?: string;

  @IsOptional()
  @IsString()
  webauthn_session_token?: string;
}
