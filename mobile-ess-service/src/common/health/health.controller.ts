import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * `GET /healthz` (liveness) - no dependency checks, same reasoning as
 * every other service's `HealthController`: a Postgres outage must not
 * make an orchestrator kill and restart an otherwise-healthy instance.
 *
 * `GET /readyz` (readiness) - Postgres is this service's system of record
 * for `OfflineActionQueue`; a Postgres outage means this instance cannot
 * serve a correct sync, so it flips this endpoint to `503`.
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
