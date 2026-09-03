import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { RequestWithTokenClaims } from './access-token.guard';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Phase 9 (docs/adr/0133): third guard in every gated resolver's
 * `@UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)`
 * list - not present in core's own copy of this guard trio, because core's
 * own guards and tenant resolution share the same request/process. Here,
 * tenant scope comes from an `x-tenant-id` header
 * (`TenantContextService`/`TenantContextMiddleware`, ADR-0014's own
 * disclosed placeholder), a completely separate mechanism from the JWT's
 * own `tenant_id` claim. Without cross-checking the two, a valid token for
 * tenant A holding the right permission would still pass `PermissionsGuard`
 * against a spoofed `x-tenant-id: B` header.
 *
 * Originally a manual `assertTokenTenantMatches(claims, tenantId)` call
 * each resolver method had to remember to make - promoted to a guard so a
 * future gated resolver can't forget it, and so its rejection is recorded
 * the same way `AccessTokenGuard`/`PermissionsGuard` record theirs
 * (`ai_rbac_denials_total{reason="forbidden_tenant_mismatch"}` - Guards run
 * before `HttpMetricsInterceptor`, so this can't be observed any other way).
 */
@Injectable()
export class TenantTokenMatchGuard implements CanActivate {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly metrics: MetricsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = this.getRequest(context);
    const claims = request.tokenClaims;
    const tenantId = this.tenantContext.requireTenantId();

    if (!claims || claims.tenant_id !== tenantId) {
      this.metrics.recordRbacDenial('forbidden_tenant_mismatch');
      throw new ForbiddenException("The access token's tenant does not match the request's tenant context.");
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
