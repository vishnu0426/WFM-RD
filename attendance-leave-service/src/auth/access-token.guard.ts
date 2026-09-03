import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 * ADR-0150/ADR-0157. Own copy of mobile-ess-service's Bearer-token guard
 * (itself a copy of core's `src/modules/auth/rest/access-token.guard.ts`),
 * same adaptation ai-layer-service/integration-hub-service/mobile-ess-service
 * already made for a genuinely separate deployable service (docs/adr/0130,
 * docs/adr/0145) - copied here rather than imported, since this platform
 * has no shared library for it. Closes this service's slice of ADR-0014's
 * header-trust gap for the two endpoints real mobile traffic actually
 * reaches (`EmployeeAttendanceRecordController`, `EmployeeLeaveBalanceController`).
 *
 * **Remote JWKS, not a DB lookup.** `jose`'s `createRemoteJWKSet` fetches
 * core's public JWKS (`GET {CORE_JWKS_URI}`, real OIDC Discovery) and
 * caches/rotates it automatically.
 *
 * **No revocation check** - access tokens are short-lived
 * (`ACCESS_TOKEN_TTL_SECONDS`, core's own `token.service.ts`); a revoked
 * but not-yet-expired token would still pass. Same disclosed, bounded
 * trade-off every prior copy of this guard already accepts.
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
    const request = context.switchToHttp().getRequest<RequestWithTokenClaims>();
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
}
