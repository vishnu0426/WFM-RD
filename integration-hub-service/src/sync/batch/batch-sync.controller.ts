import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { BatchSyncRunnerService } from './batch-sync-runner.service';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';

/**
 * §3.2's `POST /v1/integrations/connectors/{id}/sync` - batch connectors
 * only; rejects `acd` (`SyncNotSupportedForConnectorTypeError`, mapped to
 * 400 by `DomainErrorFilter`).
 *
 * ADR-0160: this endpoint runs a real batch sync against a real HRIS/
 * payroll/CRM using this connector's own Vault-referenced credential - had
 * no guards at all before this ADR. Gated the same way as
 * `RelayController`'s start/stop, `integration_connector:write` (triggering
 * a sync is an operation on the connector, the same risk tier as writing
 * it).
 */
@Controller('v1/integrations/connectors')
export class BatchSyncController {
  constructor(
    private readonly runner: BatchSyncRunnerService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:write')
  @Post(':id/sync')
  async trigger(@Param('id') connectorId: string): Promise<{ jobId: string; status: string; syncType: string }> {
    const tenantId = this.tenantContext.requireTenantId();
    const job = await this.runner.triggerManualSync(tenantId, connectorId);
    return { jobId: job.id, status: job.status, syncType: job.syncType };
  }
}
