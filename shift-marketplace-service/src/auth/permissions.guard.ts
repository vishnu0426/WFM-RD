import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { RequestWithTokenClaims } from './access-token.guard';
import { PERMISSIONS_METADATA_KEY } from './require-permissions.decorator';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Own copy of `ai-layer-service`'s `PermissionsGuard` - identical
 * GraphQL-context-aware shape. Checks `request.tokenClaims.permissions`
 * against `@RequirePermissions(...)`. Must run after `AccessTokenGuard` in
 * the same `@UseGuards(...)` list - this guard only reads `tokenClaims`, it
 * doesn't validate the token itself.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly metrics: MetricsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<string[]>(PERMISSIONS_METADATA_KEY, context.getHandler());
    if (!required || required.length === 0) {
      return true;
    }

    const request = this.getRequest(context);
    const claims = request.tokenClaims;
    if (!claims) {
      this.metrics.recordRbacDenial('unauthenticated');
      throw new UnauthorizedException('PermissionsGuard requires AccessTokenGuard to run first.');
    }

    const missing = required.filter((permission) => !claims.permissions.includes(permission));
    if (missing.length > 0) {
      this.metrics.recordRbacDenial('forbidden_permission');
      throw new ForbiddenException(`Missing required permission(s): ${missing.join(', ')}`);
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
