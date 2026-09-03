import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MarketplaceRedisService } from '../../redis/redis.service';

/**
 * `GET /healthz` (liveness) - "is this process alive." No dependency
 * checks, same reasoning as every other service's `HealthController` in
 * this platform.
 *
 * `GET /readyz` (readiness) - both Postgres and Redis are non-negotiable
 * for this module: Postgres is the system of record for `MarketplacePost`/
 * `MarketplaceClaim`/etc., and Redis is the claim flow's actual
 * concurrency-safety mechanism (§4/§0.5's chaos scenario - Redis down must
 * fail closed, not silently fall back to an unlocked write). Either
 * dependency being unreachable flips this endpoint to `503`.
 */
@Controller()
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: MarketplaceRedisService,
  ) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readiness(): Promise<{
    status: 'ok' | 'degraded';
    postgres: 'ok' | 'unreachable';
    redis: 'ok' | 'unreachable';
  }> {
    const postgres = await this.dataSource
      .query('SELECT 1')
      .then(() => 'ok' as const)
      .catch(() => 'unreachable' as const);
    const redisPing = await this.redis.ping();
    const redis = redisPing.ok ? ('ok' as const) : ('unreachable' as const);
    const status = postgres === 'ok' && redis === 'ok' ? ('ok' as const) : ('degraded' as const);
    return { status, postgres, redis };
  }
}
