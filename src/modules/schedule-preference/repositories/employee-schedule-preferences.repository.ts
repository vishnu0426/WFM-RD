import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { EmployeeSchedulePreference } from '../entities/employee-schedule-preference.entity';

@Injectable()
export class EmployeeSchedulePreferencesRepository extends TenantScopedRepository<EmployeeSchedulePreference> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, EmployeeSchedulePreference, tenantContext);
  }

  async findForEmployee(employeeId: string): Promise<EmployeeSchedulePreference | null> {
    return this.findOne({ where: { employeeId } as never });
  }
}
