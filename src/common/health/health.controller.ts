import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service';

/**
 * Phase 7 (§1's observability requirement, ADR-0050). Two distinct checks,
 * the standard Kubernetes-style split:
 *
 * `GET /healthz` (liveness) - "is this process alive at all." No
 * dependency checks - a Postgres/Redis outage must not make an
 * orchestrator kill and restart otherwise-healthy app instances (that
 * would turn a dependency outage into a self-inflicted capacity outage on
 * top of it). Always 200 if the process can respond at all.
 *
 * `GET /readyz` (readiness) - "should this instance receive traffic right
 * now." Checks Postgres (a cheap `SELECT 1`) and Redis (`PING`) are both
 * reachable. Redis being down does NOT fail readiness - §1's own posture
 * is that a Redis outage degrades latency, not availability (every Redis-
 * touching service already fails open to Postgres) - so this endpoint
 * reports Redis's state for visibility but only Postgres unreachability
 * actually flips the response to 503, since Postgres unreachable means
 * this instance genuinely cannot serve any tenant-scoped request.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @HttpCode(HttpStatus.OK)
  async readiness(): Promise<{ status: 'ok'; postgres: 'ok'; redis: 'ok' | 'unreachable' }> {
    let postgresOk = true;
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      postgresOk = false;
    }

    let redisOk = true;
    try {
      await this.redis.getClient().ping();
    } catch {
      redisOk = false;
    }

    if (!postgresOk) {
      throw new ServiceUnavailableException({ status: 'unavailable', postgres: 'unreachable' });
    }
    return { status: 'ok', postgres: 'ok', redis: redisOk ? 'ok' : 'unreachable' };
  }
}
