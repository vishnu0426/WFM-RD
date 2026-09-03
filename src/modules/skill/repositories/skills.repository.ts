import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { Skill } from '../entities/skill.entity';

@Injectable()
export class SkillsRepository extends TenantScopedRepository<Skill> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, Skill, tenantContext);
  }

  async findByCategory(category: string): Promise<Skill[]> {
    return this.find({ where: { category } as never });
  }
}
