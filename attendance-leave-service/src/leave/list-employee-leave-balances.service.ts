import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LeaveBalance } from './entities/leave-balance.entity';
import { withTenantConnection } from '../database/with-tenant-connection';

/**
 * Module 11 Phase 7 (docs/adr/0156): the mobile self-service Hours tab's
 * "leave balance" data source. Filtered to **current** periods only
 * (`periodStart <= today <= periodEnd`) - a "my balance" screen is a
 * narrow current-state visibility need, not an audit trail of every
 * historical period.
 */
@Injectable()
export class ListEmployeeLeaveBalancesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listCurrentForEmployee(tenantId: string, employeeId: string): Promise<LeaveBalance[]> {
    const today = new Date().toISOString().slice(0, 10);
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager
        .createQueryBuilder(LeaveBalance, 'balance')
        .where('balance.tenantId = :tenantId', { tenantId })
        .andWhere('balance.employeeId = :employeeId', { employeeId })
        .andWhere('balance.periodStart <= :today', { today })
        .andWhere('balance.periodEnd >= :today', { today })
        .getMany(),
    );
  }
}
