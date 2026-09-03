import { DataSource, EntityManager } from 'typeorm';
import { BidOpportunityService } from '../../../src/marketplace/bid-opportunity.service';
import { BidOpportunity, BidRankingMethod } from '../../../src/marketplace/entities/bid-opportunity.entity';

const TENANT_ID = 'tenant-1';
const POST_ID = 'post-1';

function opportunity(overrides: Partial<BidOpportunity> = {}): BidOpportunity {
  return {
    id: 'opportunity-1',
    tenantId: TENANT_ID,
    marketplacePostId: POST_ID,
    biddingWindowStart: new Date('2026-01-01T00:00:00Z'),
    biddingWindowEnd: new Date('2026-01-02T00:00:00Z'),
    rankingMethod: BidRankingMethod.FIRST_COME,
    ...overrides,
  };
}

describe('BidOpportunityService.findByMarketplacePostId (Shift Marketplace Manager View phase, §4)', () => {
  let manager: jest.Mocked<Pick<EntityManager, 'findOne' | 'query'>>;
  let dataSource: Pick<DataSource, 'transaction'>;
  let service: BidOpportunityService;

  beforeEach(() => {
    manager = { findOne: jest.fn(), query: jest.fn().mockResolvedValue(undefined) };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    service = new BidOpportunityService(dataSource as DataSource);
  });

  it('looks up the most recently created opportunity for the post, scoped to the tenant', async () => {
    const found = opportunity();
    manager.findOne.mockResolvedValue(found);

    const result = await service.findByMarketplacePostId(TENANT_ID, POST_ID);

    expect(manager.findOne).toHaveBeenCalledWith(
      BidOpportunity,
      expect.objectContaining({
        where: { marketplacePostId: POST_ID, tenantId: TENANT_ID },
        order: { biddingWindowStart: 'DESC' },
      }),
    );
    expect(result).toEqual(found);
  });

  it('returns null when the post has no bid opportunity', async () => {
    manager.findOne.mockResolvedValue(null);

    const result = await service.findByMarketplacePostId(TENANT_ID, 'post-with-no-opportunity');

    expect(result).toBeNull();
  });
});
