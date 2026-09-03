import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { RequestWithTokenClaims } from './access-token.guard';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Second guard in `@UseGuards(AccessTokenGuard, TenantTokenMatchGuard)` -
 * same pattern ai-layer-service/integration-hub-service established
 * (docs/adr/0130, docs/adr/0145). Tenant scope comes from an `x-tenant-id`
 * header (`TenantContextService`/`TenantContextMiddleware`, ADR-0014's own
 * disclosed placeholder), a completely separate mechanism from the JWT's
 * own `tenant_id` claim. Without cross-checking the two, a valid token for
 * tenant A holding a working session would still pass with a spoofed
 * `x-tenant-id: B` header.
 *
 * Must run AFTER `AccessTokenGuard` in the same `@UseGuards(...)` list -
 * NestJS executes guards left-to-right, and this guard reads
 * `request.tokenClaims`, which only `AccessTokenGuard` sets.
 */
@Injectable()
export class TenantTokenMatchGuard implements CanActivate {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly metrics: MetricsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithTokenClaims>();
    const claims = request.tokenClaims;
    const tenantId = this.tenantContext.requireTenantId();

    if (!claims || claims.tenant_id !== tenantId) {
      this.metrics.recordRbacDenial('forbidden_tenant_mismatch');
      throw new ForbiddenException("The access token's tenant does not match the request's tenant context.");
    }
    return true;
  }
}
