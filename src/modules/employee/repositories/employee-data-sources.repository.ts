import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { EmployeeDataSource } from '../entities/employee-data-source.entity';

@Injectable()
export class EmployeeDataSourcesRepository extends TenantScopedRepository<EmployeeDataSource> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, EmployeeDataSource, tenantContext);
  }

  async findForEmployee(employeeId: string): Promise<EmployeeDataSource[]> {
    return this.find({ where: { employeeId } as never, order: { dataSource: 'ASC' } as never });
  }

  /** Backs `Employee.dataSources` when resolved for a whole `employees()` list (Profiles table) - one query instead of N. */
  async findForEmployees(employeeIds: string[]): Promise<EmployeeDataSource[]> {
    if (employeeIds.length === 0) return [];
    return this.find({ where: { employeeId: In(employeeIds) } as never });
  }

  async findByIdOrNull(id: string): Promise<EmployeeDataSource | null> {
    return this.findOne({ where: { id } as never });
  }
}
