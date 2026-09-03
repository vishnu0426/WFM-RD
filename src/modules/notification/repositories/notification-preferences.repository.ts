import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { NotificationPreference } from '../entities/notification-preference.entity';

@Injectable()
export class NotificationPreferencesRepository extends TenantScopedRepository<NotificationPreference> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, NotificationPreference, tenantContext);
  }

  async findForUser(userId: string): Promise<NotificationPreference[]> {
    return this.find({ where: { userId } as never });
  }
}
