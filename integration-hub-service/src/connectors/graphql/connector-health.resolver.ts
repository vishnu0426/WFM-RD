import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { IntegrationConnectorsService } from '../integration-connectors.service';
import { SyncJobsService } from '../../sync/sync-jobs.service';
import { IntegrationConnector, SyncJobStatus } from '../../integrations/entities/integration-connector.entity';
import { SyncType } from '../../integrations/entities/sync-job.entity';
import { isStreamingConnectorType } from '../../integrations/connector-type.utils';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { ConnectorHealthResult, toSyncJobResult } from './types';

const RECENT_SYNC_JOB_LIMIT = 5;

/**
 * §7 Phase 8's connector health dashboard - a single aggregating query
 * over data every prior phase already made real (`IntegrationConnector`'s
 * own status/last-sync columns, `SyncJob` history, `StreamingRelayService`'s
 * latest streaming `SyncJob`), not a new subsystem. No schema change: this
 * is a read-side composition, the same shape as `syncJobHistory` itself,
 * just joined across a tenant's whole connector set instead of one
 * connector at a time.
 */
@Resolver(() => ConnectorHealthResult)
export class ConnectorHealthResolver {
  constructor(
    private readonly connectors: IntegrationConnectorsService,
    private readonly syncJobs: SyncJobsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:read')
  @Query(() => ConnectorHealthResult, { name: 'connectorHealth' })
  async connectorHealth(@Args('connectorId', { type: () => ID }) connectorId: string): Promise<ConnectorHealthResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const connector = await this.connectors.findByIdForTenant(tenantId, connectorId);
    return this.buildHealth(tenantId, connector);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:read')
  @Query(() => [ConnectorHealthResult], { name: 'connectorsHealth' })
  async connectorsHealth(): Promise<ConnectorHealthResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const connectors = await this.connectors.findAllForTenant(tenantId);
    return Promise.all(connectors.map((connector) => this.buildHealth(tenantId, connector)));
  }

  private async buildHealth(tenantId: string, connector: IntegrationConnector): Promise<ConnectorHealthResult> {
    const recentSyncJobs = await this.syncJobs.findHistoryForConnector(tenantId, connector.id, RECENT_SYNC_JOB_LIMIT);

    let hasActiveStreamingSession = false;
    if (isStreamingConnectorType(connector.connectorType)) {
      const latestStreaming = await this.syncJobs.findLatestForConnector(tenantId, connector.id, SyncType.STREAMING);
      hasActiveStreamingSession = latestStreaming?.status === SyncJobStatus.RUNNING;
    }

    return {
      connectorId: connector.id,
      provider: connector.provider,
      connectorType: connector.connectorType,
      status: connector.status,
      lastSyncAt: connector.lastSyncAt,
      lastSyncStatus: connector.lastSyncStatus,
      recentSyncJobs: recentSyncJobs.map(toSyncJobResult),
      hasActiveStreamingSession,
    };
  }
}
