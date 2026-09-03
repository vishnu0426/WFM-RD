import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { CoreEventingModule } from '../../modules/core-eventing/core-eventing.module';
import { AuditModule } from '../../modules/audit/audit.module';
import { WebhookModule } from '../../modules/webhook/webhook.module';
import { NotificationModule } from '../../modules/notification/notification.module';

/**
 * Phase 7 (ADR-0050). Imports the leaf modules whose repositories back the
 * queue-depth gauges (`CoreEventingModule`, `AuditModule`, `WebhookModule`,
 * and - GAP-05 fix, enterprise readiness audit 2026-08-18 - `NotificationModule`)
 * - none of them import `MetricsModule` or each other in this direction, so
 * there's no cycle. Not exported as `@Global` - `HttpMetricsInterceptor` is
 * registered directly in `app.module.ts` alongside this module, the same
 * shape as `IdempotencyInterceptor`.
 */
@Module({
  imports: [CoreEventingModule, AuditModule, WebhookModule, NotificationModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
