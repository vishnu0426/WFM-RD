import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { EmployeeSkillHistory } from '../entities/employee-skill-history.entity';

/**
 * GAP-07 fix (enterprise readiness audit, 2026-08-18). Read-only, trigger-
 * written only - see the entity's doc comment. Same shape as
 * `EmployeeHistoryRepository`.
 */
@Injectable()
export class EmployeeSkillHistoryRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  private withScope<R>(work: Parameters<typeof withTenantTransaction<R>>[2]): Promise<R> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, work);
  }

  async findHistory(employeeId: string, skillId: string): Promise<EmployeeSkillHistory[]> {
    return this.withScope((manager) =>
      manager
        .getRepository(EmployeeSkillHistory)
        .find({ where: { employeeId, skillId } as never, order: { validFrom: 'ASC' } as never }),
    );
  }

  async findVersionAsOf(employeeId: string, skillId: string, asOf: Date): Promise<EmployeeSkillHistory | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.withScope((manager) =>
      manager
        .getRepository(EmployeeSkillHistory)
        .createQueryBuilder('h')
        .where('h.tenant_id = :tenantId', { tenantId })
        .andWhere('h.employee_id = :employeeId', { employeeId })
        .andWhere('h.skill_id = :skillId', { skillId })
        .andWhere('h.valid_from <= :asOf', { asOf })
        .andWhere('(h.valid_to IS NULL OR h.valid_to > :asOf)', { asOf })
        .getOne(),
    );
  }
}
