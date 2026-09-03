import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { EmployeeGroup } from '../entities/employee-group.entity';

@Injectable()
export class EmployeeGroupsRepository extends TenantScopedRepository<EmployeeGroup> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, EmployeeGroup, tenantContext);
  }

  async findAll(
    filter: { organizationId?: string; parentGroupId?: string; status?: string; rootOnly?: boolean } = {},
  ): Promise<EmployeeGroup[]> {
    const { rootOnly, ...rest } = filter;
    const where: Record<string, unknown> = { ...rest };
    if (rootOnly && !rest.parentGroupId) where.parentGroupId = IsNull();
    return this.find({ where: where as never, order: { name: 'ASC' } as never });
  }

  async findByIdOrNull(id: string): Promise<EmployeeGroup | null> {
    return this.findOne({ where: { id } as never });
  }
}
