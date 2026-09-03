import { Inject } from '@nestjs/common';
import { Args, ID, Query, Resolver, Subscription } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { QueueLiveStateQueryService } from '../../live-state/queue-live-state-query.service';
import { QueueLiveStateResult } from '../../live-state/types';
import { GRAPHQL_PUBSUB } from '../pubsub.provider';
import { queueLiveStateUpdatedTrigger } from '../subscription-triggers';

/**
 * §4.1's `queueLiveState(queueId)` query and `queueLiveStateUpdated`
 * subscription - the latter backed by the NATS event stream via a
 * subscription bridge (§4.1's own words), not polling Redis on an
 * interval: `QueueMetricsUpdatedConsumerService` publishes to the
 * per-queue PubSub trigger this subscription reads from, so a push
 * happens exactly when a real `queue.metrics_updated` NATS message
 * arrives, nothing more.
 *
 * The subscription does not yet re-verify `X-Tenant-Id` against the
 * WebSocket connection the way the query/mutation paths do via
 * `TenantContextMiddleware` - `graphql-ws` connection-level auth is a
 * real, flagged gap (design doc/readiness checklist), not solved here.
 */
@Resolver(() => QueueLiveStateResult)
export class QueueLiveStateResolver {
  constructor(
    private readonly queueLiveStateQuery: QueueLiveStateQueryService,
    private readonly tenantContext: TenantContextService,
    @Inject(GRAPHQL_PUBSUB) private readonly pubSub: PubSub,
  ) {}

  @Query(() => QueueLiveStateResult, { name: 'queueLiveState', nullable: true })
  async queueLiveState(@Args('queueId', { type: () => ID }) queueId: string): Promise<QueueLiveStateResult | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.queueLiveStateQuery.getQueueLiveState(tenantId, queueId);
  }

  @Subscription(() => QueueLiveStateResult, { name: 'queueLiveStateUpdated' })
  queueLiveStateUpdated(@Args('queueId', { type: () => ID }) queueId: string): AsyncIterator<unknown> {
    return this.pubSub.asyncIterator(queueLiveStateUpdatedTrigger(queueId));
  }
}
