import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { WebhookSubscription } from '../entities/webhook-subscription.entity';

@Injectable()
export class WebhookSubscriptionsRepository extends TenantScopedRepository<WebhookSubscription> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, WebhookSubscription, tenantContext);
  }

  async findActiveForTenant(): Promise<WebhookSubscription[]> {
    return this.find({ where: { isActive: true } as never });
  }
}
