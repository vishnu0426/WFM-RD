import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { PlatformAdminGuard } from '../../auth/platform-admin.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { OnboardingFunnelTenant, TenantHealthRow, TenantMonitoringService } from '../tenant-monitoring.service';

/**
 * Tenant Monitoring dashboard (internal CS tool): both routes are
 * deliberately cross-tenant - `PlatformAdminGuard` replaces the
 * `TenantTokenMatchGuard` every other RBAC-gated controller in this service
 * uses (see that guard's own doc comment for why), and neither handler
 * calls `TenantContextService.requireTenantId()`.
 */
@Controller('v1/tenant-monitoring')
export class TenantMonitoringController {
  constructor(private readonly tenantMonitoring: TenantMonitoringService) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, PlatformAdminGuard)
  @RequirePermissions('tenant_monitoring:read')
  @Get('onboarding-funnel')
  async getOnboardingFunnel(): Promise<{ tenants: OnboardingFunnelTenant[] }> {
    return { tenants: await this.tenantMonitoring.getOnboardingFunnel() };
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, PlatformAdminGuard)
  @RequirePermissions('tenant_monitoring:read')
  @Get('health')
  async getHealth(): Promise<{ tenants: TenantHealthRow[] }> {
    return { tenants: await this.tenantMonitoring.getHealth() };
  }
}
