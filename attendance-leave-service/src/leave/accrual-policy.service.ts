import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AccrualPolicy } from './entities/accrual-policy.entity';
import { LeaveType } from './entities/leave-type.entity';
import { CreateAccrualPolicyDto } from './dto/create-accrual-policy.dto';
import { UpdateAccrualPolicyDto } from './dto/update-accrual-policy.dto';
import { AccrualPolicyNotFoundError } from '../common/errors/accrual-policy-not-found.error';
import { AccrualPolicyInUseError } from '../common/errors/accrual-policy-in-use.error';
import { withTenantConnection } from '../database/with-tenant-connection';

/**
 * User Management audit GAP-02's real accrual catalog — see
 * `AccrualPolicy`'s own doc comment for why this is self-contained rather
 * than the cross-service `EmploymentPolicy` link that was never actually
 * built. No `@InjectRepository` - RLS requires `withTenantConnection`,
 * same reasoning as every other service in `LeaveModule`.
 */
@Injectable()
export class AccrualPolicyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async create(tenantId: string, dto: CreateAccrualPolicyDto): Promise<AccrualPolicy> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const row = manager.create(AccrualPolicy, {
        id: randomUUID(),
        tenantId,
        name: dto.name,
        accrualRatePerPeriod: dto.accrualRatePerPeriod.toString(),
        accrualFrequency: dto.accrualFrequency,
        maxBalanceCap: dto.maxBalanceCap != null ? dto.maxBalanceCap.toString() : null,
      });
      return manager.save(row);
    });
  }

  async findAll(tenantId: string): Promise<AccrualPolicy[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.find(AccrualPolicy, { where: { tenantId }, order: { name: 'ASC' } }),
    );
  }

  async findById(tenantId: string, id: string): Promise<AccrualPolicy> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const row = await manager.findOne(AccrualPolicy, { where: { id, tenantId } });
      if (!row) {
        throw new AccrualPolicyNotFoundError(id);
      }
      return row;
    });
  }

  async update(tenantId: string, id: string, dto: UpdateAccrualPolicyDto): Promise<AccrualPolicy> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const row = await manager.findOne(AccrualPolicy, { where: { id, tenantId } });
      if (!row) {
        throw new AccrualPolicyNotFoundError(id);
      }
      const patch: Record<string, unknown> = {};
      if (dto.name !== undefined) patch.name = dto.name;
      if (dto.accrualRatePerPeriod !== undefined) patch.accrualRatePerPeriod = dto.accrualRatePerPeriod.toString();
      if (dto.accrualFrequency !== undefined) patch.accrualFrequency = dto.accrualFrequency;
      if (dto.maxBalanceCap !== undefined) patch.maxBalanceCap = dto.maxBalanceCap != null ? dto.maxBalanceCap.toString() : null;
      if (dto.status !== undefined) patch.status = dto.status;
      await manager.update(AccrualPolicy, { id }, patch);
      return manager.findOneByOrFail(AccrualPolicy, { id });
    });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const row = await manager.findOne(AccrualPolicy, { where: { id, tenantId } });
      if (!row) {
        throw new AccrualPolicyNotFoundError(id);
      }
      const referencedBy = await manager.count(LeaveType, { where: { accrualPolicyId: id, tenantId } });
      if (referencedBy > 0) {
        throw new AccrualPolicyInUseError(id);
      }
      await manager.delete(AccrualPolicy, { id });
    });
  }
}
