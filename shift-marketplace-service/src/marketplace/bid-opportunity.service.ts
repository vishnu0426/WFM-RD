import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { BidOpportunity, BidRankingMethod } from './entities/bid-opportunity.entity';

export interface OpenBidOpportunityInput {
  tenantId: string;
  marketplacePostId: string;
  biddingWindowStart: Date;
  biddingWindowEnd: Date;
  rankingMethod: BidRankingMethod;
}

/**
 * `openBidOpportunity` is not a `§3.1` mutation (only `submitBid` is named
 * on the bidding side) - same "post/opportunity creation is system/
 * admin-integration territory, deferred" scoping every prior phase applied
 * to `MarketplacePost` (Phase 2) - this service method exists for that
 * future integration and for this phase's own tests/fixtures to call
 * directly, not exposed via GraphQL yet.
 */
@Injectable()
export class BidOpportunityService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findById(tenantId: string, bidOpportunityId: string): Promise<BidOpportunity | null> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(BidOpportunity, { where: { id: bidOpportunityId, tenantId } }),
    );
  }

  /**
   * Shift Marketplace Manager View phase, §4: backs `MarketplacePostResolver.bidOpportunityId`
   * - `marketplacePostId` isn't unique-constrained at the database level
   *   (nothing before this phase needed to enforce "at most one opportunity
   *   per post"), so this returns the most recently created match rather
   *   than assuming exactly one row.
   */
  async findByMarketplacePostId(tenantId: string, marketplacePostId: string): Promise<BidOpportunity | null> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(BidOpportunity, {
        where: { marketplacePostId, tenantId },
        order: { biddingWindowStart: 'DESC' },
      }),
    );
  }

  async openBidOpportunity(input: OpenBidOpportunityInput): Promise<BidOpportunity> {
    return withTenantConnection(this.dataSource, input.tenantId, async (manager) => {
      const opportunity = manager.create(BidOpportunity, {
        id: randomUUID(),
        tenantId: input.tenantId,
        marketplacePostId: input.marketplacePostId,
        biddingWindowStart: input.biddingWindowStart,
        biddingWindowEnd: input.biddingWindowEnd,
        rankingMethod: input.rankingMethod,
      });
      await manager.save(opportunity);
      return opportunity;
    });
  }
}
