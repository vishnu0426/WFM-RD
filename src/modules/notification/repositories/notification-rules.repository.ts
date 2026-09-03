import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { NotificationRule } from '../entities/notification-rule.entity';

@Injectable()
export class NotificationRulesRepository extends TenantScopedRepository<NotificationRule> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, NotificationRule, tenantContext);
  }

  async findForEventType(eventType: string): Promise<NotificationRule[]> {
    return this.find({ where: { eventType } as never });
  }

  async setEnabled(eventType: string, channel: string, enabled: boolean): Promise<NotificationRule> {
    const existing = await this.findOne({ where: { eventType, channel } as never });
    if (existing) {
      existing.enabled = enabled;
      return this.save(existing);
    }
    return this.save({ eventType, channel, enabled } as never);
  }
}
