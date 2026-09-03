import { Module } from '@nestjs/common';
import { WebhookModule } from './webhook/webhook.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { WebhookSubscriptionsController } from './webhook/rest/webhook-subscriptions.controller';

/**
 * Composition root for `/v1/webhooks` (§3.2, ADR-0046), same shape as
 * `TenantApiModule`/`PolicyApiModule`/`IdentityApiModule`/`AuditApiModule`:
 * `WebhookSubscriptionsController` needs `WebhookModule`'s
 * `WebhookSubscriptionsRepository` *and* `AuthModule`'s guards *and*
 * `AuditModule`'s `AuditLogRepository`. No cycle risk - `WebhookModule`
 * depends on nothing outside itself.
 */
@Module({
  imports: [WebhookModule, AuthModule, AuditModule],
  controllers: [WebhookSubscriptionsController],
})
export class WebhookApiModule {}
