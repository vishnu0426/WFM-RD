import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { LeaveType } from './entities/leave-type.entity';
import { CreateLeaveTypeDto } from './dto/create-leave-type.dto';
import { UpdateLeaveTypeDto } from './dto/update-leave-type.dto';
import { LeaveTypeNotFoundError } from '../common/errors/leave-type-not-found.error';
import { LeaveTypeInUseError } from '../common/errors/leave-type-in-use.error';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AccrualPolicyService } from './accrual-policy.service';

/** Postgres foreign_key_violation - https://www.postgresql.org/docs/current/errcodes-appendix.html */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * TypeORM's `QueryDeepPartialEntity` mapped type doesn't cleanly accept a
 * plain `Record<string, unknown>` value for a jsonb column typed the same
 * way - a known TypeORM typing limitation, not a real type mismatch (the
 * runtime value is exactly what the jsonb column expects). Same local
 * workaround `leave-request.service.ts` already uses for `conflictFlags`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asJsonbValue(value: Record<string, unknown>): any {
  return value;
}

/**
 * User Management "Time Off" screen gap-fix: `LeaveType` previously had no
 * CRUD surface at all in this service (seed/read-only). No
 * `@InjectRepository` - RLS requires `withTenantConnection`/`DataSource`,
 * same reasoning as every other service in `LeaveModule` (see its own doc
 * comment).
 */
@Injectable()
export class LeaveTypeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly accrualPolicyService: AccrualPolicyService,
  ) {}

  async create(tenantId: string, dto: CreateLeaveTypeDto): Promise<LeaveType> {
    await this.accrualPolicyService.findById(tenantId, dto.accrualPolicyId); // throws AccrualPolicyNotFoundError if missing/cross-tenant
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const row = manager.create(LeaveType, {
        id: randomUUID(),
        tenantId,
        name: dto.name,
        accrualPolicyId: dto.accrualPolicyId,
        requiresApproval: dto.requiresApproval ?? true,
        requiresDocumentation: dto.requiresDocumentation ?? false,
        maxConsecutiveDays: dto.maxConsecutiveDays ?? null,
        carryoverRules: dto.carryoverRules ?? {},
      });
      return manager.save(row);
    });
  }

  async findAll(tenantId: string): Promise<LeaveType[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.find(LeaveType, { where: { tenantId }, order: { name: 'ASC' } }),
    );
  }

  async findById(tenantId: string, id: string): Promise<LeaveType> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const row = await manager.findOne(LeaveType, { where: { id, tenantId } });
      if (!row) {
        throw new LeaveTypeNotFoundError(id);
      }
      return row;
    });
  }

  async update(tenantId: string, id: string, dto: UpdateLeaveTypeDto): Promise<LeaveType> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const row = await manager
        .createQueryBuilder(LeaveType, 'leaveType')
        .setLock('pessimistic_write')
        .where('leaveType.id = :id', { id })
        .andWhere('leaveType.tenantId = :tenantId', { tenantId })
        .getOne();
      if (!row) {
        throw new LeaveTypeNotFoundError(id);
      }

      const patch: Record<string, unknown> = { ...dto };
      if (dto.carryoverRules !== undefined) {
        patch.carryoverRules = asJsonbValue(dto.carryoverRules);
      }
      await manager.update(LeaveType, { id }, patch);
      return manager.findOneByOrFail(LeaveType, { id });
    });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const row = await manager.findOne(LeaveType, { where: { id, tenantId } });
      if (!row) {
        throw new LeaveTypeNotFoundError(id);
      }

      try {
        await manager.delete(LeaveType, { id });
      } catch (err) {
        // `leave_balance_leave_type_id_fkey`/`leave_request_leave_type_id_fkey`
        // have no ON DELETE clause (Postgres default NO ACTION) - a
        // LeaveType still referenced by an existing LeaveRequest/LeaveBalance
        // rejects the delete at the DB level. Translated here into this
        // platform's standard error envelope rather than a raw 500 -
        // matching the FK's own enforced behavior, not duplicating a
        // referential check in application code.
        if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
          throw new LeaveTypeInUseError(id);
        }
        throw err;
      }
    });
  }
}
