import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * `GET /healthz` (liveness) - "is this process alive." No dependency
 * checks, same reasoning as every other service's `HealthController` in
 * this platform: a Postgres outage must not make an orchestrator kill and
 * restart an otherwise-healthy instance - and this module's own Anthropic
 * API dependency has an even weaker connection to "should this pod be
 * restarted" (§4's whole point is that an LLM outage degrades gracefully,
 * it doesn't crash the process).
 *
 * `GET /readyz` - Postgres-gated (this module's `AIInteraction`/
 * `AIRecommendation`/`AIGovernancePolicy` system of record). The Anthropic
 * API is deliberately NOT part of readiness - an LLM outage is §4's
 * degraded-mode path, not a reason to pull this instance out of rotation
 * (degraded responses still need a live instance to serve them from).
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
