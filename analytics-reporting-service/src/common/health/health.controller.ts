import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * `GET /healthz` (liveness) - "is this process alive." No dependency
 * checks, same reasoning as every other service's `HealthController` in
 * this platform: an outage in a dependency must not make an orchestrator
 * kill and restart an otherwise-healthy instance.
 *
 * `GET /readyz` (readiness) - checks this service's own primary connection
 * (`agno_analytics_app` against the shared `agno_wfm` instance). It does
 * NOT check the analytics read replica (introduced Phase 2) - replica
 * reachability/lag is its own SLO and metric (§0.5, `analytics_replica_lag_seconds`
 * declared in `MetricsService`), not this endpoint's concern, since a lagging
 * or unreachable replica should degrade *freshness* (reflected via
 * `dataAsOf`), not this service's own liveness/readiness.
 */
@Controller()
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readiness(): Promise<{ status: 'ok' | 'degraded'; postgres: 'ok' | 'unreachable' }> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', postgres: 'ok' };
    } catch {
      return { status: 'degraded', postgres: 'unreachable' };
    }
  }
}
