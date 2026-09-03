import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { EmployeeGroupMember } from '../entities/employee-group-member.entity';

@Injectable()
export class EmployeeGroupMembersRepository extends TenantScopedRepository<EmployeeGroupMember> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, EmployeeGroupMember, tenantContext);
  }

  async findForGroup(groupId: string): Promise<EmployeeGroupMember[]> {
    return this.find({ where: { groupId } as never });
  }

  async findForEmployee(employeeId: string): Promise<EmployeeGroupMember[]> {
    return this.find({ where: { employeeId } as never });
  }

  async exists(groupId: string, employeeId: string): Promise<boolean> {
    return (await this.findOne({ where: { groupId, employeeId } as never })) !== null;
  }

  async remove(groupId: string, employeeId: string): Promise<void> {
    await this.delete({ groupId, employeeId } as never);
  }
}
