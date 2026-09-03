import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { RequestWithTokenClaims } from './access-token.guard';
import { PERMISSIONS_METADATA_KEY } from './require-permissions.decorator';

/**
 * §4's RBAC enforcement: checks `request.tokenClaims.permissions` (§3.4's
 * flat `["resource:action", ...]` claim, populated at token-issuance time
 * from every one of the caller's role assignments regardless of ABAC scope
 * - see `UserContextResolverService`) against `@RequirePermissions(...)`.
 * Must run after `AccessTokenGuard` in the same `@UseGuards(...)` list -
 * this guard only reads `tokenClaims`, it doesn't validate the token itself.
 *
 * RBAC-only: this checks *whether the caller holds the permission at all*,
 * not whether it applies to the specific resource instance being acted on -
 * that's `AbacService`'s job for endpoints where a role's grant can be
 * org-unit-scoped (§2.1) and the flattened JWT claim can't express that
 * distinction (see `AbacService`'s own doc comment).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<string[]>(PERMISSIONS_METADATA_KEY, context.getHandler());
    if (!required || required.length === 0) {
      return true;
    }

    const request = this.getRequest(context);
    const claims = request.tokenClaims;
    if (!claims) {
      throw new UnauthorizedException('PermissionsGuard requires AccessTokenGuard to run first.');
    }

    const missing = required.filter((permission) => !claims.permissions.includes(permission));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing required permission(s): ${missing.join(', ')}`);
    }
    return true;
  }

  /** GraphQL support (Phase 6) - see `AccessTokenGuard.getRequest`'s doc comment for why this can't just be `switchToHttp()`. */
  private getRequest(context: ExecutionContext): RequestWithTokenClaims {
    if (context.getType<GqlContextType>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext<{ req: RequestWithTokenClaims }>().req;
    }
    return context.switchToHttp().getRequest<RequestWithTokenClaims>();
  }
}
