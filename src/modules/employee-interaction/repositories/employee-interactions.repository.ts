import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { EmployeeInteraction } from '../entities/employee-interaction.entity';

@Injectable()
export class EmployeeInteractionsRepository extends TenantScopedRepository<EmployeeInteraction> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, EmployeeInteraction, tenantContext);
  }

  /** Newest first - a note timeline reads top-down like every other history view in this app. */
  async findForEmployee(employeeId: string): Promise<EmployeeInteraction[]> {
    return this.find({ where: { employeeId } as never, order: { createdAt: 'DESC' } as never });
  }

  async findByIdOrNull(id: string): Promise<EmployeeInteraction | null> {
    return this.findOne({ where: { id } as never });
  }

  /** Only `body` is ever patched here - see `EmployeeInteraction`'s own doc comment for why the rest stays immutable. */
  async updateBody(id: string, body: string): Promise<void> {
    await this.update({ id } as never, { body } as never);
  }

  async remove(id: string): Promise<void> {
    await this.delete({ id } as never);
  }
}
