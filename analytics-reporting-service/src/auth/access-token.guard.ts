import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Core's own JWT access token claim shape - only the fields this service
 * actually reads are typed here. `roles` (role *names*, per
 * `UserContextResolverService`'s own doc comment in core) is the addition
 * beyond adherence-compliance-service's identical copy of this file: the
 * dashboard-sharing fix needs the caller's currently-held roles, not just
 * their flat permission list, to resolve `SavedReport.sharedWith` against
 * a *live* identity rather than a snapshot recorded at share time.
 */
export interface AccessTokenClaims extends JWTPayload {
  tenant_id: string;
  permissions: string[];
  roles: string[];
}

export interface RequestWithTokenClaims extends Request {
  tokenClaims?: AccessTokenClaims;
}

/**
 * Own copy of integration-hub-service's/ai-layer-service's/
 * adherence-compliance-service's identical Bearer-token guard (ADR-0145/
 * ADR-0130/ADR-0161) - this module's own first RBAC infrastructure, this
 * service having previously had none at all (every dashboard/metric write
 * open to any caller with a valid X-Tenant-Id header).
 *
 * - **Remote JWKS, not a DB lookup.** `jose`'s `createRemoteJWKSet` fetches
 *   core's public JWKS (`GET {CORE_JWKS_URI}`, real OIDC Discovery) and
 *   caches/rotates it automatically - this service has no access to core's
 *   own `signing_keys` table (a completely separate Postgres role/schema).
 * - **No revocation check**, same disclosed, bounded trade-off every other
 *   copy of this guard in this platform already accepted - access tokens
 *   are short-lived (720s, core's own `token.service.ts`).
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
      // rejection never reaches that interceptor at all.
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
