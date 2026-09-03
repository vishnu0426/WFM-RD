import { Injectable, Logger } from '@nestjs/common';
import { DurableConsumerBinding } from '../nats/bind-durable-consumer';
import { DurableJetStreamConsumer } from '../nats/durable-jetstream-consumer.base';
import { IntradayNatsClientService } from '../nats/nats-client.service';
import { AgentStateChangedPayload, INTRADAY_STREAM_NAME, INTRADAY_SUBJECTS } from '../nats/subjects';
import { IntradayRedisService } from '../redis/redis.service';

/**
 * §4.3/§8 Phase 2: the first real consumer of `agent.state_changed` -
 * writes `currentActivity`/`activityStartedAt`/`siteId`/`queueId` into
 * `AgentLiveState`, nothing else (never touches `scheduledActivity`/
 * `adherenceStatus` - `ScheduledActivityService` owns those independently,
 * see `IntradayRedisService`'s partial-write doc comment). Redelivery on
 * failure (`DurableJetStreamConsumer`'s nak) is safe here specifically
 * because this consumer only ever writes these four fields - a retry is
 * last-write-wins on them, never a partial/torn write spanning two
 * different messages.
 *
 * Phase 6: also reads the employee's prior `AgentLiveState` before writing
 * (one extra `HGETALL`) to get the previous `queueId`, then calls
 * `updateQueueMembership` so `queueAgentsKey`'s reverse index stays in
 * sync - the only way `ReallocationRecommendationService` can answer
 * "which employees are in queue X" with real data rather than a fabricated
 * guess. A deliberate, bounded cost added to this consumer's hot path -
 * see the Phase 6 design doc/readiness checklist for why this wasn't
 * measured against a load test here (Phase 7's job). The read is best-effort
 * for membership purposes only: if it fails, `previousQueueId` falls back to
 * `null` (treated as "no prior queue to remove from") rather than blocking
 * the state write itself, which is the actually time-sensitive part of this
 * consumer's job.
 */
@Injectable()
export class AgentStateChangedConsumerService extends DurableJetStreamConsumer<AgentStateChangedPayload> {
  protected readonly logger = new Logger(AgentStateChangedConsumerService.name);

  constructor(
    natsClient: IntradayNatsClientService,
    private readonly redis: IntradayRedisService,
  ) {
    super(natsClient);
  }

  protected binding(): DurableConsumerBinding {
    return {
      stream: INTRADAY_STREAM_NAME,
      durableName: 'intraday-agent-state-changed',
      filterSubject: `${INTRADAY_SUBJECTS.AGENT_STATE_CHANGED_PREFIX}.>`,
    };
  }

  /** Public (widened from the base class's `protected abstract`) so unit tests can call it directly without a real `JsMsg`. */
  async handlePayload(payload: AgentStateChangedPayload): Promise<void> {
    const previousQueueId = await this.readPreviousQueueId(payload.tenantId, payload.employeeId);

    await this.redis.writeAgentLiveState(payload.tenantId, payload.employeeId, {
      currentActivity: payload.currentActivity,
      activityStartedAt: payload.activityStartedAt,
      siteId: payload.siteId,
      queueId: payload.queueId,
    });

    try {
      await this.redis.updateQueueMembership(payload.tenantId, payload.employeeId, previousQueueId, payload.queueId);
    } catch (err) {
      // Same reasoning as the read above: the state write just above this
      // already succeeded, and that's this consumer's actual job (Phase 2) -
      // a reverse-index update failure must not turn into a redelivery loop
      // that repeats an already-successful write.
      this.logger.warn(
        `Failed to update queue membership for tenant ${payload.tenantId} employee ${payload.employeeId}: ${(err as Error).message}`,
      );
    }
  }

  /** Best-effort - unlike this class's own state write, a failure here must never block it (see this class's doc comment). Falls back to `null` (no prior queue to remove from) rather than propagating. */
  private async readPreviousQueueId(tenantId: string, employeeId: string): Promise<string | null> {
    try {
      const existing = await this.redis.readAgentLiveState(tenantId, employeeId);
      return existing?.queueId ?? null;
    } catch (err) {
      this.logger.warn(
        `Failed to read prior AgentLiveState for tenant ${tenantId} employee ${employeeId} before a queue-membership update - reverse index may go stale: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
