import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * §3.4's exact JWT access token claim shape (core's own `AccessTokenClaims`)
 * - only the fields this service actually reads are typed here. `roles`
 * added for the Tenant Monitoring onboarding "Data Sources" step's
 * platform_admin cross-tenant connector-provisioning endpoint (see
 * `PlatformAdminGuard`) - unused elsewhere in this service.
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
 * §7 Phase 8 (ADR-0145): own copy of core's (`src/modules/auth/rest/
 * access-token.guard.ts`) Bearer-token guard, adapted for a genuinely
 * separate deployable service rather than the same process that issues
 * the token - identical shape to ai-layer-service's own copy (ADR-0130):
 *
 * - **Remote JWKS, not a DB lookup.** Core's own guard resolves the signing
 *   key via `SigningKeyService.resolveVerificationKey`, a direct read
 *   against its own `signing_keys` table - not available here (a
 *   completely separate Postgres role/schema, ADR-0136). `jose`'s
 *   `createRemoteJWKSet` fetches core's public JWKS
 *   (`GET {CORE_JWKS_URI}`, real OIDC Discovery) and caches/rotates it
 *   automatically.
 * - **No revocation check**, same disclosed, bounded trade-off ai-layer-
 *   service's own copy already accepted - access tokens are short-lived
 *   (720s, core's own `token.service.ts`), the standard trade-off most
 *   OIDC resource servers make rather than requiring a shared revocation
 *   cache with every downstream service.
 * - **No `client:`-subject rejection** - `createConnector`/
 *   `createWebhookSubscription` are ordinary tenant-admin config writes a
 *   legitimate automated provisioning pipeline could also perform via
 *   `client_credentials`, the same reasoning ai-layer-service's own copy
 *   already applied.
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
