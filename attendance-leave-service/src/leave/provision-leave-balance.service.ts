import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LeaveBalance } from './entities/leave-balance.entity';
import { LeaveType } from './entities/leave-type.entity';
import { ProvisionLeaveBalanceDto } from './dto/provision-leave-balance.dto';
import { LeaveTypeNotFoundError } from '../common/errors/leave-type-not-found.error';
import { LeaveBalanceAlreadyExistsError } from '../common/errors/leave-balance-already-exists.error';
import { withTenantConnection } from '../database/with-tenant-connection';

/** Postgres unique_violation - https://www.postgresql.org/docs/current/errcodes-appendix.html */
const UNIQUE_VIOLATION = '23505';

/**
 * Admin write path for `LeaveBalance`, closing the gap
 * `LeaveBalanceNotFoundError`'s own doc comment previously disclosed (no
 * provisioning surface existed anywhere in this service). Same
 * `withTenantConnection` posture as every other service in `LeaveModule` -
 * RLS requires the per-request tenant GUC a plain `@InjectRepository` never
 * sets.
 */
@Injectable()
export class ProvisionLeaveBalanceService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async provision(tenantId: string, employeeId: string, dto: ProvisionLeaveBalanceDto): Promise<LeaveBalance> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const leaveType = await manager.findOne(LeaveType, { where: { id: dto.leaveTypeId, tenantId } });
      if (!leaveType) {
        throw new LeaveTypeNotFoundError(dto.leaveTypeId);
      }

      const row = manager.create(LeaveBalance, {
        tenantId,
        employeeId,
        leaveTypeId: dto.leaveTypeId,
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
        accruedDays: dto.accruedDays.toString(),
        usedDays: '0',
        pendingDays: '0',
        carryoverDaysIn: (dto.carryoverDaysIn ?? 0).toString(),
        carryoverExpiryDate: dto.carryoverExpiryDate ?? null,
        carryoverApplied: false,
      });
      try {
        // `manager.insert(...)` deliberately, not `.save(...)`: with every
        // column of this entity's composite PK already set, TypeORM's
        // `save()` silently upserts (INSERT ... ON CONFLICT DO UPDATE) -
        // re-provisioning an existing period would silently overwrite its
        // accrued/used/pending state instead of being rejected. `insert()`
        // issues a plain INSERT that actually raises unique_violation on a
        // real conflict.
        await manager.insert(LeaveBalance, row);
        return row;
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new LeaveBalanceAlreadyExistsError(employeeId, dto.leaveTypeId, dto.periodStart, dto.periodEnd);
        }
        throw err;
      }
    });
  }
}
