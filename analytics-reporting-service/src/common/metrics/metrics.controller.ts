import { Controller, Get, Header } from '@nestjs/common';
import { contentType } from 'prom-client';
import { MetricsService } from './metrics.service';

/** Prometheus text-exposition format, same convention as every other service's `MetricsController` in this platform. */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('content-type', contentType)
  async getMetrics(): Promise<string> {
    return this.metrics.getRegistry().metrics();
  }
}
