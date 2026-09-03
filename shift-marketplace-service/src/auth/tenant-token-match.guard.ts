import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { RequestWithTokenClaims } from './access-token.guard';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Own copy of `ai-layer-service`'s guard - third in every gated resolver's
 * `@UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)`
 * list. Tenant scope comes from an `X-Tenant-Id` header
 * (`TenantContextService`/`TenantContextMiddleware`, this service's
 * existing header-trust placeholder), a completely separate mechanism from
 * the JWT's own `tenant_id` claim. Without cross-checking the two, a valid
 * token for tenant A would still pass `PermissionsGuard` against a spoofed
 * `X-Tenant-Id: B` header.
 *
 * Must run AFTER `AccessTokenGuard` - this guard reads `request.tokenClaims`,
 * which only `AccessTokenGuard` sets.
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
