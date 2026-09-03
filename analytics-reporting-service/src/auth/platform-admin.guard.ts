import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { RequestWithTokenClaims } from './access-token.guard';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Tenant Monitoring dashboard (internal CS tool): a hard role check, not
 * just a permission check. `PermissionsGuard`/`tenant_monitoring:read`
 * alone would still be correct today (the permission seed excludes
 * `tenant_admin` from it - see `seedSystemRoles()` in core's
 * `run-seed.ts`), but every other cross-tenant capability in this platform
 * (`TenantContext.isPlatformAdmin()` in core) is gated by the `platform_admin`
 * *role* directly, not by whether some permission happens to be bound to
 * it - a future re-seed that accidentally rebinds `tenant_monitoring:read`
 * to another role must not silently grant it cross-tenant read. `roles` is
 * already present on this service's own `AccessTokenClaims`
 * (`access-token.guard.ts`) but had no reader anywhere before this guard.
 *
 * Must run after `AccessTokenGuard` in the same `@UseGuards(...)` list -
 * this guard only reads `tokenClaims`, it doesn't validate the token
 * itself. Deliberately used *instead of* `TenantTokenMatchGuard` on the
 * routes it guards - those routes are cross-tenant by design, so there is
 * no single "the" tenant to match against an `x-tenant-id` header.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly metrics: MetricsService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = this.getRequest(context);
    const claims = request.tokenClaims;

    if (!claims?.roles?.includes('platform_admin')) {
      this.metrics.recordRbacDenial('forbidden_not_platform_admin');
      throw new ForbiddenException('This endpoint is restricted to platform_admin.');
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
