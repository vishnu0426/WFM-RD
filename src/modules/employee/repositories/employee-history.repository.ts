import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { EmployeeHistory } from '../entities/employee-history.entity';

/** Read-only, trigger-written only - see the entity's doc comment. */
@Injectable()
export class EmployeeHistoryRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  private withScope<R>(work: Parameters<typeof withTenantTransaction<R>>[2]): Promise<R> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, work);
  }

  async findHistory(employeeId: string): Promise<EmployeeHistory[]> {
    return this.withScope((manager) =>
      manager
        .getRepository(EmployeeHistory)
        .find({ where: { employeeId } as never, order: { validFrom: 'ASC' } as never }),
    );
  }

  async findVersionAsOf(employeeId: string, asOf: Date): Promise<EmployeeHistory | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.withScope((manager) =>
      manager
        .getRepository(EmployeeHistory)
        .createQueryBuilder('h')
        .where('h.tenant_id = :tenantId', { tenantId })
        .andWhere('h.employee_id = :employeeId', { employeeId })
        .andWhere('h.valid_from <= :asOf', { asOf })
        .andWhere('(h.valid_to IS NULL OR h.valid_to > :asOf)', { asOf })
        .getOne(),
    );
  }
}
