import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { MetricsService } from '../common/metrics/metrics.service';

/** Core's own JWT access token claim shape - only the fields this service actually reads are typed here. */
export interface AccessTokenClaims extends JWTPayload {
  tenant_id: string;
  permissions: string[];
}

export interface RequestWithTokenClaims extends Request {
  tokenClaims?: AccessTokenClaims;
}

/**
 * Attendance & Leave Manager Views / Shift Marketplace Manager View phases:
 * own copy of `ai-layer-service`'s Bearer-token guard (itself a copy of
 * core's `src/modules/auth/rest/access-token.guard.ts`), the
 * GraphQL-context-aware variant - this service's API surface is entirely
 * GraphQL, unlike attendance-leave-service's REST-only copy of the same
 * guard, so `getRequest` has to switch on `context.getType()` rather than
 * always calling `context.switchToHttp()`.
 *
 * **Remote JWKS, not a DB lookup.** `jose`'s `createRemoteJWKSet` fetches
 * core's public JWKS (`GET {CORE_JWKS_URI}`) and caches/rotates it
 * automatically - the standard "resource server" half of the same OIDC
 * architecture core's own `TokenService` implements as the "authorization
 * server" half.
 *
 * **No revocation check** - access tokens are short-lived; a revoked but
 * not-yet-expired token would still pass. Same disclosed, bounded trade-off
 * every prior copy of this guard already accepts.
 *
 * Only applied to the genuinely new, manager-only operations this phase
 * adds (`pendingMarketplaceActions`, `rejectMarketplaceAction`,
 * `marketplacePosts`, `bids`, `marketplaceHealthSnapshot`, and the
 * newly-gated `approveMarketplaceAction`) - the existing employee-facing
 * reads (`bid`, `bidOpportunity`, `marketplacePost`, the
 * `marketplacePostUpdated` subscription) stay ungated, since Module 11's
 * mobile app already calls them without a bearer token and retrofitting a
 * permission requirement would break that flow without a corresponding
 * default-grant story.
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
