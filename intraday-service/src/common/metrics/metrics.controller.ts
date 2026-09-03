import { Controller, Get, Header } from '@nestjs/common';
import { contentType } from 'prom-client';
import { MetricsService } from './metrics.service';

/** Prometheus text-exposition format, same convention as the root app's `MetricsController`. */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('content-type', contentType)
  async getMetrics(): Promise<string> {
    return this.metrics.getRegistry().metrics();
  }
}
