import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MetricsService } from '../common/metrics/metrics.service';
import { IntradayRedisService } from './redis.service';

/**
 * §6.1/§0.5 Phase 7: a proactive Redis health signal. Before this, Redis
 * health was only ever checked reactively - `/readyz` pings per-request,
 * and live-state queries only discover an outage by trying a real call and
 * catching `IntradayRedisUnavailableError`. Neither populates `/metrics`
 * unless something happens to touch Redis during the outage - you cannot
 * page on a signal that doesn't exist (§0.5's on-call ask: "sustained
 * Redis write-latency regression").
 *
 * Deliberately **not** consulted by `AgentLiveStateQueryService`/
 * `QueueLiveStateQueryService` - those keep their existing, already-proven
 * reactive try/catch (Phase 4). A 15s-stale cached "Redis is up" flag is
 * exactly the kind of looks-live-but-isn't gap §6.1's own opening line
 * rules out. This service exists purely to make Redis health visible in
 * `/metrics` and in logs between requests, not to gate response
 * correctness.
 */
@Injectable()
export class RedisHeartbeatService {
  private readonly logger = new Logger(RedisHeartbeatService.name);
  private lastKnownUp: boolean | null = null;

  constructor(
    private readonly redis: IntradayRedisService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron('*/15 * * * * *')
  async tick(): Promise<void> {
    const { ok, latencyMs } = await this.redis.ping();
    this.metrics.setRedisUp(ok);
    this.metrics.observeRedisOperation('heartbeat', latencyMs / 1000);

    if (this.lastKnownUp !== false && !ok) {
      this.logger.error('Redis heartbeat failed - flipping to down');
    } else if (this.lastKnownUp === false && ok) {
      this.logger.log(`Redis heartbeat recovered (${latencyMs}ms)`);
    }
    this.lastKnownUp = ok;
  }
}
