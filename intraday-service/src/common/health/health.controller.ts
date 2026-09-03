import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IntradayRedisService } from '../../redis/redis.service';

/**
 * `GET /healthz` (liveness) - "is this process alive." No dependency
 * checks, same reasoning as the root app's `HealthController`: a Redis/NATS/
 * Postgres outage must not make an orchestrator kill and restart
 * otherwise-healthy instances.
 *
 * `GET /readyz` (readiness):
 * - Redis: ADR-0062's fail-*visible* posture made concrete - `redis:
 *   "unreachable"` flips this endpoint to `503`, since Redis is this
 *   service's live-state system of record; a Redis outage genuinely means
 *   this instance cannot serve a correct live read/write.
 * - Postgres (Phase 3): reported but **non-fatal** - a deliberate,
 *   documented asymmetry with Redis, not an oversight. Postgres backs
 *   `AdherenceEvent`, a durable pipeline this service's ingestion/Redis
 *   dashboard functionality does not depend on (see
 *   `AdherenceCalculatorConsumerService`'s own doc comment) - a Postgres
 *   outage should show up as consumer nak/lag metrics, not as this
 *   instance refusing all traffic including the parts of it Postgres has
 *   nothing to do with.
 * - `region` (Phase 8, ADR-0072): which regional stack this instance
 *   belongs to (`INTRADAY_REGION`, defaulted for a single-region
 *   deployment) - so a future gateway/routing layer, and this instance's
 *   own logs, can be checked against the intended multi-region topology
 *   rather than silently trusting DNS routing did the right thing. Not a
 *   routing decision this service makes itself - see ADR-0072.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly redis: IntradayRedisService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readiness(): Promise<{
    status: 'ok';
    redis: 'ok';
    redisLatencyMs: number;
    postgres: 'ok' | 'unreachable';
    region: string;
  }> {
    const region = this.config.get<string>('INTRADAY_REGION', 'single-region-dev');
    const { ok, latencyMs } = await this.redis.ping();
    if (!ok) {
      throw new ServiceUnavailableException({
        status: 'degraded',
        redis: 'unreachable',
        redisLatencyMs: latencyMs,
        region,
      });
    }

    let postgresOk = true;
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      postgresOk = false;
    }

    return {
      status: 'ok',
      redis: 'ok',
      redisLatencyMs: latencyMs,
      postgres: postgresOk ? 'ok' : 'unreachable',
      region,
    };
  }
}
