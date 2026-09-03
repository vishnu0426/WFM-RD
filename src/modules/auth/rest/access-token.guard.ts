import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';
import { TokenService, AccessTokenClaims } from '../services/token.service';
import { TokenRevocationService } from '../services/token-revocation.service';

export interface RequestWithTokenClaims extends Request {
  tokenClaims?: AccessTokenClaims;
}

/**
 * Bearer-token guard for endpoints that need "a valid, non-revoked access
 * token for a real user" - not this platform's own OAuth surface (which
 * issues tokens, doesn't consume them) but a first consumer of one:
 * `WebAuthnController`'s credential-registration endpoints need to know
 * *which already-authenticated user* is registering a passkey.
 *
 * Deliberately rejects `client_credentials`-issued machine tokens (`sub`
 * starting with `client:` - see `OAuthController.handleClientCredentialsGrant`'s
 * doc comment) - registering a passkey is a real-user action.
 *
 * Phase 6: also usable on GraphQL resolvers (`PlatformGraphQLModule`) -
 * `context.switchToHttp()` doesn't resolve a real Express request under
 * Apollo's GraphQL execution context, so `getRequest` below reads from
 * `GqlExecutionContext`'s `{req}` (Nest's default Apollo context shape,
 * `app.module.ts`'s `GraphQLModule.forRoot` doesn't override it) when the
 * call came through `/graphql` instead.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly tokenRevocation: TokenRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = this.getRequest(context);
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
    if (claims.sub.startsWith('client:')) {
      throw new UnauthorizedException('This endpoint requires a user access token, not a client_credentials token.');
    }
    if (await this.tokenRevocation.isRevoked(claims.jti)) {
      throw new UnauthorizedException('Access token has been revoked.');
    }

    request.tokenClaims = claims;
    return true;
  }

  private getRequest(context: ExecutionContext): RequestWithTokenClaims {
    if (context.getType<GqlContextType>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext<{ req: RequestWithTokenClaims }>().req;
    }
    return context.switchToHttp().getRequest<RequestWithTokenClaims>();
  }
}
