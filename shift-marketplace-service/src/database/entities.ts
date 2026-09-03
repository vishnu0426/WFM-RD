import { MarketplacePost } from '../marketplace/entities/marketplace-post.entity';
import { MarketplaceClaim } from '../marketplace/entities/marketplace-claim.entity';
import { SwapRequest } from '../marketplace/entities/swap-request.entity';
import { BidOpportunity } from '../marketplace/entities/bid-opportunity.entity';
import { Bid } from '../marketplace/entities/bid.entity';
import { MarketplaceEngagementScore } from '../marketplace/entities/marketplace-engagement-score.entity';
import { MarketplaceEngagementEvent } from '../marketplace/entities/marketplace-engagement-event.entity';
import { MarketplaceOutboxEvent } from '../marketplace/entities/marketplace-outbox-event.entity';

/**
 * Single source of truth for "every entity in this service," consumed by
 * both the NestJS `TypeOrmModule` registration and the CLI `DataSource`
 * used for migrations - same convention as every other service's
 * `src/database/entities.ts`.
 */
export const entities = [
  MarketplacePost,
  MarketplaceClaim,
  SwapRequest,
  BidOpportunity,
  Bid,
  MarketplaceEngagementScore,
  MarketplaceEngagementEvent,
  MarketplaceOutboxEvent,
];

export {
  MarketplacePost,
  MarketplaceClaim,
  SwapRequest,
  BidOpportunity,
  Bid,
  MarketplaceEngagementScore,
  MarketplaceEngagementEvent,
  MarketplaceOutboxEvent,
};
