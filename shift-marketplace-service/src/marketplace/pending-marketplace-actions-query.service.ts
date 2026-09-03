import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { MarketplaceClaim, MarketplaceClaimStatus } from './entities/marketplace-claim.entity';
import { MarketplacePost } from './entities/marketplace-post.entity';
import { SwapRequest, SwapRequestStatus } from './entities/swap-request.entity';

export interface PendingMarketplaceActions {
  /** Each pending claim paired with the post it's against - the "shift detail" context §2 of the frontend prompt asks the queue row to show. */
  claims: { claim: MarketplaceClaim; post: MarketplacePost }[];
  swaps: SwapRequest[];
}

/**
 * Shift Marketplace Manager View phase, §2 of the frontend prompt: the
 * approval queue's list endpoint - no such query existed before this phase
 * (`MarketplacePostQueryService`/`SwapRequestService` only ever had
 * `findById`). Org-unit scoping needs no gRPC roster resolution (unlike
 * attendance-leave-service's equivalent last phase) - `MarketplacePost.orgUnitId`
 * and `SwapRequest.initiatorOrgUnitId`/`targetOrgUnitId` are already real
 * columns on these entities. Posts are resolved first, then claims filtered
 * by `marketplacePostId IN (...)` - a plain `IN` filter, not a cross-entity
 * subquery, same idiom the attendance-leave-service org-unit-scoped queries
 * already established.
 */
@Injectable()
export class PendingMarketplaceActionsQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listForOrgUnit(tenantId: string, orgUnitId: string): Promise<PendingMarketplaceActions> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const posts = await manager
        .createQueryBuilder(MarketplacePost, 'post')
        .where('post.tenantId = :tenantId', { tenantId })
        .andWhere('post.orgUnitId = :orgUnitId', { orgUnitId })
        .getMany();
      const postIds = posts.map((post) => post.id);
      const postsById = new Map(posts.map((post) => [post.id, post]));

      const claimEntities =
        postIds.length === 0
          ? []
          : await manager
              .createQueryBuilder(MarketplaceClaim, 'claim')
              .where('claim.tenantId = :tenantId', { tenantId })
              .andWhere('claim.marketplacePostId IN (:...postIds)', { postIds })
              .andWhere('claim.status = :status', { status: MarketplaceClaimStatus.PENDING_APPROVAL })
              .orderBy('claim.claimedAt', 'DESC')
              .getMany();
      const claims = claimEntities.map((claim) => ({
        claim,
        post: postsById.get(claim.marketplacePostId) as MarketplacePost,
      }));

      const swaps = await manager
        .createQueryBuilder(SwapRequest, 'swap')
        .where('swap.tenantId = :tenantId', { tenantId })
        .andWhere('swap.status = :status', { status: SwapRequestStatus.PENDING_APPROVAL })
        .andWhere('(swap.initiatorOrgUnitId = :orgUnitId OR swap.targetOrgUnitId = :orgUnitId)', { orgUnitId })
        .orderBy('swap.createdAt', 'DESC')
        .getMany();

      return { claims, swaps };
    });
  }
}
