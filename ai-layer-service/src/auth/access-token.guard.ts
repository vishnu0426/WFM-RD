import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { MetricsService } from '../common/metrics/metrics.service';

/** §3.4's exact JWT access token claim shape (core's own `AccessTokenClaims`) - only the fields this service actually reads are typed here. */
export interface AccessTokenClaims extends JWTPayload {
  tenant_id: string;
  permissions: string[];
}

export interface RequestWithTokenClaims extends Request {
  tokenClaims?: AccessTokenClaims;
}

/**
 * Phase 8 (docs/adr/0130): own copy of core's (`src/modules/auth/rest/access-token.guard.ts`)
 * Bearer-token guard, adapted for a genuinely separate deployable service
 * rather than the same process that issues the token:
 *
 * - **Remote JWKS, not a DB lookup.** Core's own guard resolves the signing
 *   key via `SigningKeyService.resolveVerificationKey`, a direct read
 *   against its own `signing_keys` table - not available here (a
 *   completely separate Postgres role/schema, ADR-0113). `jose`'s
 *   `createRemoteJWKSet` fetches core's public JWKS
 *   (`GET {CORE_JWKS_URI}`, real OIDC Discovery per
 *   `WellKnownController`) and caches/rotates it automatically - the
 *   standard "resource server" half of the same OIDC architecture core's
 *   own `TokenService` implements as the "authorization server" half.
 * - **No revocation check.** Core's own guard also calls
 *   `TokenRevocationService.isRevoked(claims.jti)` - a live check against
 *   core's own revocation store, likewise unavailable here. A revoked but
 *   not-yet-expired token would still pass this guard. Disclosed, bounded
 *   risk: access tokens are short-lived (`ACCESS_TOKEN_TTL_SECONDS = 720`,
 *   core's own `token.service.ts`), the same trade-off most OIDC resource
 *   servers make (centralize revocation checking at the issuer, rely on
 *   short TTLs downstream) rather than requiring every resource server to
 *   share a live revocation cache.
 * - **No `client:`-subject rejection.** Core's own guard rejects
 *   `client_credentials`-issued machine tokens because its one consumer
 *   (WebAuthn passkey registration) is a "must be a real user" action.
 *   `configureAiProvider`/`updateGovernancePolicy` are ordinary tenant-admin
 *   config writes that a legitimate automated provisioning pipeline could
 *   also perform via `client_credentials` - restricting to real users only
 *   was considered and not applied here, since nothing about these two
 *   mutations actually requires a human.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    const jwksUri = config.get<string>('CORE_JWKS_URI', 'http://localhost:3000/.well-known/jwks.json');
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
    this.issuer = config.get<string>('OIDC_ISSUER', 'https://auth.agno-wfm.local');
    this.audience = config.get<string>('OIDC_AUDIENCE', 'agno-core-api');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = this.getRequest(context);
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      // Recorded here, not `HttpMetricsInterceptor` - Guards run before
      // Interceptors in NestJS's request lifecycle, so a Guard-thrown
      // rejection never reaches that interceptor at all (docs/adr/0133).
      this.metrics.recordRbacDenial('unauthenticated');
      throw new UnauthorizedException('Missing Bearer access token.');
    }
    const token = header.slice('Bearer '.length);

    try {
      const { payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer, audience: this.audience });
      request.tokenClaims = payload as AccessTokenClaims;
    } catch {
      this.metrics.recordRbacDenial('unauthenticated');
      throw new UnauthorizedException('Access token is invalid, expired, or signed by an unrecognized key.');
    }

    return true;
  }

  private getRequest(context: ExecutionContext): RequestWithTokenClaims {
    if (context.getType<GqlContextType>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext<{ req: RequestWithTokenClaims }>().req;
    }
    return context.switchToHttp().getRequest<RequestWithTokenClaims>();
  }
}
