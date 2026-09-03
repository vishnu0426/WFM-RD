import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { SyncJobsService } from '../../sync/sync-jobs.service';
import { BatchSyncRunnerService } from '../../sync/batch/batch-sync-runner.service';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { SyncJobResult, toSyncJobResult } from './types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

/**
 * §3.1's `syncJobHistory(connectorId, limit)` - needed from Phase 3 itself
 * to observe this phase's own real batch sync outcomes. Phase 7 adds
 * `triggerManualSync` here too - the GraphQL counterpart to the REST
 * `POST /v1/integrations/connectors/{id}/sync` endpoint §3.2 already names
 * (`BatchSyncController`, unchanged), both calling the same
 * `BatchSyncRunnerService.triggerManualSync` - no duplicated logic between
 * the two transports.
 */
@Resolver(() => SyncJobResult)
export class SyncJobHistoryResolver {
  constructor(
    private readonly syncJobs: SyncJobsService,
    private readonly batchSyncRunner: BatchSyncRunnerService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:read')
  @Query(() => [SyncJobResult], { name: 'syncJobHistory' })
  async syncJobHistory(
    @Args('connectorId') connectorId: string,
    @Args('limit', { type: () => Number, nullable: true }) limit?: number,
  ): Promise<SyncJobResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const boundedLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const jobs = await this.syncJobs.findHistoryForConnector(tenantId, connectorId, boundedLimit);
    return jobs.map(toSyncJobResult);
  }

  /** Same permission `POST /v1/integrations/connectors/{id}/sync` (`BatchSyncController`, unchanged) already requires - this mutation calls the identical `BatchSyncRunnerService.triggerManualSync`, so it needs the identical gate. */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:write')
  @Mutation(() => SyncJobResult)
  async triggerManualSync(@Args('connectorId', { type: () => ID }) connectorId: string): Promise<SyncJobResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const job = await this.batchSyncRunner.triggerManualSync(tenantId, connectorId);
    return toSyncJobResult(job);
  }
}
