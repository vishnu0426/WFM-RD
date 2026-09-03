import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntradayRedisService } from '../redis/redis.service';
import { IntradayNatsClientService } from '../nats/nats-client.service';
import { INTRADAY_SUBJECTS, AgentStateChangedPayload, agentStateChangedSubject } from '../nats/subjects';
import { UpstreamUnavailableError } from '../common/errors/upstream-unavailable.error';
import { MetricsService } from '../common/metrics/metrics.service';
import { ActivityEventDto } from './dto/activity-event.dto';

export type IngestionOutcome = 'accepted' | 'duplicate';

/**
 * §4.2/§8 Phase 1: verify (the guard, before this runs) → dedupe → publish.
 * Deliberately does **not** touch `AgentLiveState`/`QueueLiveState` directly
 * - per §5's architecture, that's the Phase 2 NATS consumer's job, kept
 * separate so this service's only write path in this phase is the
 * idempotency lock, and so Phase 2 can be added without touching this class.
 */
@Injectable()
export class IngestionService {
  constructor(
    private readonly redis: IntradayRedisService,
    private readonly nats: IntradayNatsClientService,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  async ingest(tenantId: string, event: ActivityEventDto): Promise<IngestionOutcome> {
    const acquired = await this.acquireLock(tenantId, event.sourceEventId);
    if (!acquired) {
      this.metrics.recordIngestionEvent('duplicate');
      return 'duplicate';
    }

    try {
      await this.publish(tenantId, event);
    } catch (err) {
      // See IntradayRedisService.releaseIngestionIdempotencyLock's doc
      // comment - without this, a legitimate ACD retry after this 503 would
      // be silently swallowed as a duplicate for the rest of the TTL.
      await this.redis.releaseIngestionIdempotencyLock(tenantId, event.sourceEventId);
      this.metrics.recordIngestionEvent('upstream_unavailable');
      throw err;
    }

    this.metrics.recordIngestionEvent('accepted');
    return 'accepted';
  }

  private async acquireLock(tenantId: string, sourceEventId: string): Promise<boolean> {
    const ttlSeconds = this.config.get<number>('INTRADAY_IDEMPOTENCY_TTL_SECONDS', 86400);
    const start = process.hrtime.bigint();
    try {
      return await this.redis.acquireIngestionIdempotencyLock(tenantId, sourceEventId, ttlSeconds);
    } catch (err) {
      this.metrics.recordIngestionEvent('upstream_unavailable');
      throw new UpstreamUnavailableError('redis', err);
    } finally {
      this.metrics.observeRedisOperation('acquireIngestionIdempotencyLock', secondsSince(start));
    }
  }

  private async publish(tenantId: string, event: ActivityEventDto): Promise<void> {
    const payload: AgentStateChangedPayload = {
      tenantId,
      employeeId: event.employeeId,
      sourceEventId: event.sourceEventId,
      currentActivity: event.currentActivity,
      activityStartedAt: event.activityStartedAt,
      siteId: event.siteId ?? null,
      queueId: event.queueId ?? null,
      receivedAt: new Date().toISOString(),
    };

    const subject = agentStateChangedSubject(event.employeeId);
    const start = process.hrtime.bigint();
    try {
      await this.nats.publish(subject, payload as unknown as Record<string, unknown>);
    } catch (err) {
      throw new UpstreamUnavailableError('nats', err);
    } finally {
      this.metrics.observeNatsPublish(INTRADAY_SUBJECTS.AGENT_STATE_CHANGED_PREFIX, secondsSince(start));
    }
  }
}

function secondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
