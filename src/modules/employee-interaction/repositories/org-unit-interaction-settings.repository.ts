import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { OrgUnitInteractionSettings } from '../entities/org-unit-interaction-settings.entity';

@Injectable()
export class OrgUnitInteractionSettingsRepository extends TenantScopedRepository<OrgUnitInteractionSettings> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, OrgUnitInteractionSettings, tenantContext);
  }

  async findForOrgUnit(orgUnitId: string): Promise<OrgUnitInteractionSettings | null> {
    return this.findOne({ where: { orgUnitId } as never });
  }
}
