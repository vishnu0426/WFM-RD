import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * `GET /healthz` (liveness) - "is this process alive." No dependency
 * checks, same reasoning as every other service's `HealthController` in
 * this platform: a Postgres outage must not make an orchestrator kill and
 * restart an otherwise-healthy instance.
 *
 * `GET /readyz` (readiness) - Postgres is this module's system of record
 * for everything it owns in this phase. A Postgres outage means this
 * instance cannot serve a correct read or write, so it flips this endpoint
 * to `503`. Once Phase 2 adds Vault (§1, ADR-0134), a Vault outage should
 * fail closed the same way §0.5's chaos-test posture requires - not added
 * here since nothing reads Vault yet.
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
