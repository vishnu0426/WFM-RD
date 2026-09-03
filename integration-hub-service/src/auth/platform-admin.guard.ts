import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { RequestWithTokenClaims } from './access-token.guard';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Tenant Monitoring onboarding "Data Sources" step (internal CS/ops tool):
 * own copy of the identical guard already built this session in the root
 * service and analytics-reporting-service - a hard `platform_admin` role
 * check, used instead of `TenantTokenMatchGuard` on routes that are
 * deliberately cross-tenant (a platform admin provisioning a connector for
 * a brand-new tenant that has no ambient session of its own yet).
 *
 * Must run after `AccessTokenGuard` in the same `@UseGuards(...)` list -
 * this guard only reads `tokenClaims`, it doesn't validate the token itself.
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
