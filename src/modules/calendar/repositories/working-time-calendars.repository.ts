import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { WorkingTimeCalendar } from '../entities/working-time-calendar.entity';

@Injectable()
export class WorkingTimeCalendarsRepository extends TenantScopedRepository<WorkingTimeCalendar> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, WorkingTimeCalendar, tenantContext);
  }

  async findForOrgUnit(orgUnitId: string): Promise<WorkingTimeCalendar | null> {
    return this.findOne({ where: { orgUnitId } as never });
  }

  /** The tenant-wide default calendar (`org_unit_id IS NULL`). */
  async findTenantDefault(): Promise<WorkingTimeCalendar | null> {
    return this.findOne({ where: { orgUnitId: IsNull() } as never });
  }
}
