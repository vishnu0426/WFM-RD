import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { WorkRule } from '../entities/work-rule.entity';

@Injectable()
export class WorkRulesRepository extends TenantScopedRepository<WorkRule> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, WorkRule, tenantContext);
  }

  async findAll(): Promise<WorkRule[]> {
    return this.find({ order: { name: 'ASC' } as never });
  }

  async findByIdOrNull(id: string): Promise<WorkRule | null> {
    return this.findOne({ where: { id } as never });
  }

  async findByIds(ids: string[]): Promise<WorkRule[]> {
    if (ids.length === 0) return [];
    const all = await this.findAll();
    const idSet = new Set(ids);
    return all.filter((r) => idSet.has(r.id));
  }
}
