import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { PlatformAdminGuard } from '../../auth/platform-admin.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { IntegrationConnectorsService } from '../integration-connectors.service';

/**
 * Tenant Monitoring onboarding "Data Sources" step (internal CS/ops tool,
 * root service's platform-admin console): read-only status, no create
 * action. `IntegrationConnectorsService.create` hard-requires either
 * `credentials` or `oauth` (real Vault-bound material) - there is no
 * "reserve a connector, configure credentials later" shape anywhere in
 * this service, confirmed live (a bare connectorType+provider POST is
 * rejected with `INVALID_CREATE_CONNECTOR_INPUT`), not assumed. Rather
 * than have platform_admin collect a real credential during onboarding
 * (the master prompt's own "never expose secrets" instruction, and this
 * platform's existing boundary that platform_admin doesn't do a tenant's
 * own day-to-day configuration), this step stays read-only: BACKEND GAP
 * for real onboarding-time connector creation, documented rather than
 * routed around. A tenant's own admin still creates real connectors, with
 * real credentials, via the existing GraphQL `createConnector` mutation
 * once they've logged in.
 *
 * Deliberately cross-tenant (`:tenantId` from the URL, not the caller's
 * own ambient `TenantContextService` + `TenantTokenMatchGuard` every other
 * endpoint in this service uses) - gated by `PlatformAdminGuard` instead.
 * `IntegrationConnectorsService.findAllForTenant` already takes `tenantId`
 * as an explicit parameter, so no context override is needed here at all.
 */
@Controller('v1/tenants/:tenantId/connectors')
@UseGuards(AccessTokenGuard, PermissionsGuard, PlatformAdminGuard)
export class TenantConnectorsController {
  constructor(private readonly connectors: IntegrationConnectorsService) {}

  @Get('exists')
  @RequirePermissions('integration_connector:read')
  async exists(@Param('tenantId') tenantId: string): Promise<{ hasConnectors: boolean }> {
    const rows = await this.connectors.findAllForTenant(tenantId);
    return { hasConnectors: rows.length > 0 };
  }
}
