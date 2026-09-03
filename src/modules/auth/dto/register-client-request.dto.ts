import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUrl } from 'class-validator';
import { OAuthGrantType } from '../entities/oauth-grant-type.enum';
import { TokenEndpointAuthMethod } from '../entities/token-endpoint-auth-method.enum';

/**
 * RFC 7591 §2's minimal registration metadata subset this platform needs.
 * `POST /oauth/register` is gated by a static bootstrap token
 * (`OAUTH_CLIENT_REGISTRATION_TOKEN`), not per-request admin RBAC - see
 * ADR-0026 and the module README: real admin-permission gating needs the
 * RBAC enforcement that ships in Phase 4.
 */
export class RegisterClientRequestDto {
  @IsString()
  client_name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsUrl({ require_tld: false }, { each: true })
  redirect_uris!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(Object.values(OAuthGrantType), { each: true })
  grant_types!: OAuthGrantType[];

  @IsIn(Object.values(TokenEndpointAuthMethod))
  token_endpoint_auth_method!: TokenEndpointAuthMethod;

  @IsOptional()
  @IsString()
  scope?: string;
}
