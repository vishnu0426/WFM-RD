import { Controller, Get, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SigningKeyService } from '../services/signing-key.service';
import { OAuthGrantType } from '../entities/oauth-grant-type.enum';
import { TokenEndpointAuthMethod } from '../entities/token-endpoint-auth-method.enum';
import { OAuthErrorFilter } from './oauth-error.filter';

/**
 * §5.6: OIDC Discovery + JWKS for the platform acting as its own OIDC
 * provider. Root-level `/.well-known/*` paths are RFC 8414/OIDC Discovery
 * §4-mandated, not this platform's own `/v1/` REST convention.
 */
@Controller('.well-known')
@UseFilters(OAuthErrorFilter)
export class WellKnownController {
  private readonly issuer: string;

  constructor(
    private readonly signingKeyService: SigningKeyService,
    config: ConfigService,
  ) {
    this.issuer = config.get<string>('OIDC_ISSUER', 'https://auth.agno-wfm.local');
  }

  @Get('openid-configuration')
  openidConfiguration(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      introspection_endpoint: `${this.issuer}/oauth/introspect`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      jwks_uri: `${this.issuer}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: Object.values(OAuthGrantType),
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: Object.values(TokenEndpointAuthMethod),
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email'],
      claims_supported: [
        'sub',
        'tenant_id',
        'org_unit_id',
        'roles',
        'permissions',
        'amr',
        'auth_time',
        'iss',
        'aud',
        'exp',
        'iat',
      ],
    };
  }

  @Get('jwks.json')
  async jwks(): Promise<Record<string, unknown>> {
    return this.signingKeyService.getJwks();
  }
}
