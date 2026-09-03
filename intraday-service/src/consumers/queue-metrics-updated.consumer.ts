import { Inject, Injectable, Logger } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { queueLiveStateUpdatedTrigger } from '../graphql/subscription-triggers';
import { GRAPHQL_PUBSUB } from '../graphql/pubsub.provider';
import { DurableConsumerBinding } from '../nats/bind-durable-consumer';
import { DurableJetStreamConsumer } from '../nats/durable-jetstream-consumer.base';
import { IntradayNatsClientService } from '../nats/nats-client.service';
import { INTRADAY_STREAM_NAME, INTRADAY_SUBJECTS, QueueMetricsUpdatedPayload } from '../nats/subjects';
import { IntradayRedisService } from '../redis/redis.service';
import { AlertEngineService } from '../alerting/alert-engine.service';
import { ReallocationRecommendationService } from '../reallocation/reallocation-recommendation.service';
import { StaffingOfferService } from '../staffing-offers/staffing-offer.service';

/** How long a queue stays a candidate reallocation donor/target after its last metrics update - same order of magnitude as `SCHEDULE_TRACKED_EMPLOYEE_TTL_SECONDS`'s own self-pruning window. */
const REALLOCATION_QUEUE_TRACKING_TTL_SECONDS = 600;

/**
 * §4.3/§8 Phase 4: the first real consumer of `queue.metrics_updated`
 * (provisioned since Phase 1, never consumed - `QueueLiveState` was dead
 * data until this). Writes `QueueLiveState` via
 * `IntradayRedisService.writeQueueLiveState` (built in Phase 1, never
 * called by production code before now), then re-reads it back (so the
 * published payload carries the same `lastUpdatedAt` Redis actually
 * stamped, not a client-computed timestamp that could drift) and pushes
 * it onto the in-process GraphQL PubSub for `queueLiveStateUpdated`
 * subscribers.
 *
 * No producer for this subject exists anywhere in this repo (§4.3 names
 * it as coming from "the queue monitoring service," external to every
 * phase this module builds) - verified the same way Phase 2's
 * cross-service consumers were verified, by hand-publishing a real NATS
 * message onto the subject.
 *
 * Phase 5: also feeds `AlertEngineService.evaluateQueueMetrics` after the
 * Redis write - §5a point 4's own placement ("between the raw NATS
 * consumer... and the point `alertRaised` is actually published"), kept
 * as a single call to a separate service rather than inlining the
 * dedup/suppression/escalation pipeline here.
 *
 * Phase 6: also refreshes `trackQueueForReallocationScan`'s TTL'd marker
 * and feeds `ReallocationRecommendationService.evaluateQueueMetrics` -
 * §5's own architecture list names this consumer's payload as feeding
 * "the reallocation recommendation engine" alongside the Redis state
 * updater and alert engine.
 *
 * Also feeds `StaffingOfferService.evaluateQueueMetrics` - VTO/overtime
 * offer detection, same fan-out point as the alert/reallocation engines
 * (see that service's own doc comment for scope: detection + push-trigger
 * only, this phase).
 */
@Injectable()
export class QueueMetricsUpdatedConsumerService extends DurableJetStreamConsumer<QueueMetricsUpdatedPayload> {
  protected readonly logger = new Logger(QueueMetricsUpdatedConsumerService.name);

  constructor(
    natsClient: IntradayNatsClientService,
    private readonly redis: IntradayRedisService,
    @Inject(GRAPHQL_PUBSUB) private readonly pubSub: PubSub,
    private readonly alertEngine: AlertEngineService,
    private readonly reallocationEngine: ReallocationRecommendationService,
    private readonly staffingOfferEngine: StaffingOfferService,
  ) {
    super(natsClient);
  }

  protected binding(): DurableConsumerBinding {
    return {
      stream: INTRADAY_STREAM_NAME,
      durableName: 'intraday-queue-metrics-updated',
      filterSubject: INTRADAY_SUBJECTS.QUEUE_METRICS_UPDATED,
    };
  }

  /** Public (widened from the base class's `protected abstract`) so unit tests can call it directly without a real `JsMsg`. */
  async handlePayload(payload: QueueMetricsUpdatedPayload): Promise<void> {
    await this.redis.writeQueueLiveState(payload.tenantId, payload.queueId, {
      currentVolume: payload.currentVolume,
      agentsAvailable: payload.agentsAvailable,
      agentsOnCall: payload.agentsOnCall,
      forecastedVolume: payload.forecastedVolume,
      serviceLevelCurrent: payload.serviceLevelCurrent,
      serviceLevelTarget: payload.serviceLevelTarget,
    });

    const record = await this.redis.readQueueLiveState(payload.tenantId, payload.queueId);
    if (!record) {
      // Redis became unavailable between the write and the read-back (or
      // was evicted in between) - nothing to publish; the next update
      // will catch subscribers up.
      return;
    }

    await this.redis.trackQueueForReallocationScan(
      payload.tenantId,
      payload.queueId,
      REALLOCATION_QUEUE_TRACKING_TTL_SECONDS,
    );

    await this.alertEngine.evaluateQueueMetrics(payload.tenantId, payload.queueId, record);
    await this.reallocationEngine.evaluateQueueMetrics(payload.tenantId, payload.queueId, record);
    await this.staffingOfferEngine.evaluateQueueMetrics(payload.tenantId, payload.queueId, record);

    await this.pubSub.publish(queueLiveStateUpdatedTrigger(payload.queueId), {
      queueLiveStateUpdated: {
        queueId: payload.queueId,
        currentVolume: record.currentVolume,
        agentsAvailable: record.agentsAvailable,
        agentsOnCall: record.agentsOnCall,
        forecastedVolume: record.forecastedVolume,
        serviceLevelCurrent: record.serviceLevelCurrent,
        serviceLevelTarget: record.serviceLevelTarget,
        dataFreshness: { status: 'ok' as const, lastKnownUpdateAt: new Date(record.lastUpdatedAt) },
      },
    });
  }
}
