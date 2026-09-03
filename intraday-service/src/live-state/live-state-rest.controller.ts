import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { QueueNotFoundError } from '../common/errors/queue-not-found.error';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { QueueLiveStateQueryService } from './queue-live-state-query.service';
import { QueueLiveStateResult } from './types';

/**
 * §4.2/§0.5: REST snapshot fallback for clients not using the GraphQL
 * WebSocket subscription - p99 < 200ms SLO. Shares
 * `QueueLiveStateQueryService` with the GraphQL `queueLiveState` query
 * (root app's own REST/GraphQL-share-a-service pattern,
 * `OrgUnitsController`/`OrgHierarchyService`) - one read path, two
 * transports, not two independent implementations to keep in sync.
 */
@Controller('v1/intraday/queues')
export class LiveStateRestController {
  constructor(
    private readonly queueLiveState: QueueLiveStateQueryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get(':queueId/live')
  async getQueueLive(@Param('queueId', new ParseUUIDPipe()) queueId: string): Promise<QueueLiveStateResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const result = await this.queueLiveState.getQueueLiveState(tenantId, queueId);
    if (!result) {
      throw new QueueNotFoundError(queueId);
    }
    return result;
  }
}
