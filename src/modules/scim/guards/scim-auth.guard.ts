import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService, AccessTokenClaims } from '../../auth/services/token.service';
import { TokenRevocationService } from '../../auth/services/token-revocation.service';
import { RequestWithTokenClaims } from '../../auth/rest/access-token.guard';

/**
 * §5's SCIM 2.0 authorization model for this phase: any valid, non-revoked
 * `client_credentials`-issued access token for the tenant is sufficient to
 * drive SCIM (the mirror image of `AccessTokenGuard`, which rejects exactly
 * this token shape). Coarser than per-operation scope checking - real IdP
 * SCIM connectors authenticate with one long-lived bearer credential and
 * expect to perform every SCIM operation with it, and fine-grained
 * authorization for *which* client may do *what* needs Phase 4's RBAC
 * enforcement (same deferral as `POST /oauth/register`'s bootstrap token,
 * ADR-0026) - flagged in the production readiness checklist, not silently
 * implied to be fully scoped.
 */
@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly tokenRevocation: TokenRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithTokenClaims>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer access token.');
    }
    const token = header.slice('Bearer '.length);

    let claims: AccessTokenClaims;
    try {
      claims = await this.tokenService.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException('Access token is invalid or expired.');
    }
    if (!claims.sub.startsWith('client:')) {
      throw new UnauthorizedException('SCIM requires a client_credentials access token.');
    }
    if (await this.tokenRevocation.isRevoked(claims.jti)) {
      throw new UnauthorizedException('Access token has been revoked.');
    }

    request.tokenClaims = claims;
    return true;
  }
}
