import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { StreamingRelayService } from './streaming-relay.service';
import { SyncJob } from '../../integrations/entities/sync-job.entity';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';

/**
 * §3.2's relay start/stop/status - acd connectors only; rejects any other
 * connector_type (`RelayNotSupportedForConnectorTypeError`, mapped to 400).
 *
 * ADR-0160: `relay/start` opens a live outbound OAuth/WebSocket session to
 * an external ACD provider using this connector's own Vault-referenced
 * credential (`StreamingRelayService.start`) - before this ADR, every
 * method on this controller had zero guards, meaning anyone who could set
 * `X-Tenant-Id` could open or close that session or read its status. Gated
 * the same way `createConnector`/`createWebhookSubscription` already are
 * (§7 Phase 8, ADR-0145): `integration_connector:write` for start/stop
 * (same credential-operating risk tier as writing the connector itself),
 * `integration_connector:read` for status (a pre-existing seeded
 * permission, never checked by anything until now).
 */
@Controller('v1/integrations/connectors')
export class RelayController {
  constructor(
    private readonly relay: StreamingRelayService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:write')
  @Post(':id/relay/start')
  async start(@Param('id') connectorId: string): Promise<SyncJob> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.relay.start(tenantId, connectorId);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:write')
  @Post(':id/relay/stop')
  async stop(@Param('id') connectorId: string): Promise<SyncJob> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.relay.stop(tenantId, connectorId);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:read')
  @Get(':id/relay/status')
  async status(@Param('id') connectorId: string): Promise<SyncJob | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.relay.status(tenantId, connectorId);
  }
}
