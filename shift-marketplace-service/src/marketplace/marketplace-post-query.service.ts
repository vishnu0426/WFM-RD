import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { MarketplacePost, MarketplacePostStatus } from './entities/marketplace-post.entity';

@Injectable()
export class MarketplacePostQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findById(tenantId: string, postId: string): Promise<MarketplacePost | null> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(MarketplacePost, { where: { id: postId, tenantId } }),
    );
  }

  /**
   * Shift Marketplace Manager View phase, §3 of the frontend prompt: the
   * open-posts overview's list endpoint - `findById` was this service's
   * only read method before this phase.
   */
  async listByOrgUnit(tenantId: string, orgUnitId: string, status?: MarketplacePostStatus): Promise<MarketplacePost[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) => {
      const qb = manager
        .createQueryBuilder(MarketplacePost, 'post')
        .where('post.tenantId = :tenantId', { tenantId })
        .andWhere('post.orgUnitId = :orgUnitId', { orgUnitId });
      if (status) {
        qb.andWhere('post.status = :status', { status });
      }
      return qb.orderBy('post.expiresAt', 'ASC').getMany();
    });
  }
}
