import { Controller, Get, Header } from '@nestjs/common';
import { contentType } from 'prom-client';
import { MetricsService } from './metrics.service';

/** Phase 7 (ADR-0050): Prometheus text-exposition format, scraped by the docker-compose `prometheus` service (see `observability/prometheus.yml`). */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('content-type', contentType)
  async getMetrics(): Promise<string> {
    return this.metrics.getRegistry().metrics();
  }
}
