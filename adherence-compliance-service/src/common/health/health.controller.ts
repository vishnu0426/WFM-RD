import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * `GET /healthz` (liveness) - "is this process alive." No dependency
 * checks, same reasoning as every other service's `HealthController` in
 * this platform: a Postgres outage must not make an orchestrator kill and
 * restart an otherwise-healthy instance.
 *
 * `GET /readyz` (readiness) - Postgres is this module's sole system of
 * record in this phase (no Redis/live-state cache yet, unlike Module 05's
 * ADR-0062 asymmetry). A Postgres outage means this instance cannot serve a
 * correct read or write, so it flips this endpoint to `503`.
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
