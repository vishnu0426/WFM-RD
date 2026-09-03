import { DataSource, EntityManager } from 'typeorm';
import { PendingMarketplaceActionsQueryService } from '../../../src/marketplace/pending-marketplace-actions-query.service';
import {
  MarketplaceClaim,
  MarketplaceClaimSource,
  MarketplaceClaimStatus,
} from '../../../src/marketplace/entities/marketplace-claim.entity';
import {
  MarketplacePost,
  MarketplacePostStatus,
  MarketplacePostType,
} from '../../../src/marketplace/entities/marketplace-post.entity';
import { SwapRequest, SwapRequestStatus } from '../../../src/marketplace/entities/swap-request.entity';

const TENANT_ID = 'tenant-1';
const ORG_UNIT_ID = 'org-1';

function makeQueryBuilder(): { where: jest.Mock; andWhere: jest.Mock; orderBy: jest.Mock; getMany: jest.Mock } {
  const qb = { where: jest.fn(), andWhere: jest.fn(), orderBy: jest.fn(), getMany: jest.fn() };
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  qb.orderBy.mockReturnValue(qb);
  return qb;
}

const post: MarketplacePost = {
  id: 'post-1',
  tenantId: TENANT_ID,
  postType: MarketplacePostType.OPEN_SHIFT,
  shiftAssignmentId: 'shift-1',
  orgUnitId: ORG_UNIT_ID,
  postedBy: null,
  status: MarketplacePostStatus.CLAIMED,
  eligibilityRules: {},
  expiresAt: new Date(),
  createdAt: new Date(),
};

const claim: MarketplaceClaim = {
  id: 'claim-1',
  tenantId: TENANT_ID,
  marketplacePostId: 'post-1',
  claimantEmployeeId: 'employee-1',
  status: MarketplaceClaimStatus.PENDING_APPROVAL,
  source: MarketplaceClaimSource.OPEN_SHIFT_CLAIM,
  validationResult: { eligible: true, violations: [] },
  claimedAt: new Date(),
  decisionReason: null,
};

const swap: SwapRequest = {
  id: 'swap-1',
  tenantId: TENANT_ID,
  initiatorEmployeeId: 'initiator-1',
  initiatorShiftId: 'shift-a',
  initiatorOrgUnitId: ORG_UNIT_ID,
  targetEmployeeId: 'target-1',
  targetShiftId: 'shift-b',
  targetOrgUnitId: 'org-2',
  status: SwapRequestStatus.PENDING_APPROVAL,
  requiresSupervisorApproval: true,
  validationResult: null,
  createdAt: new Date(),
  decisionReason: null,
};

describe('PendingMarketplaceActionsQueryService (Shift Marketplace Manager View phase, §2)', () => {
  let postsQb: ReturnType<typeof makeQueryBuilder>;
  let claimsQb: ReturnType<typeof makeQueryBuilder>;
  let swapsQb: ReturnType<typeof makeQueryBuilder>;
  let manager: jest.Mocked<Pick<EntityManager, 'createQueryBuilder' | 'query'>>;
  let dataSource: Pick<DataSource, 'transaction'>;
  let service: PendingMarketplaceActionsQueryService;

  beforeEach(() => {
    postsQb = makeQueryBuilder();
    claimsQb = makeQueryBuilder();
    swapsQb = makeQueryBuilder();
    postsQb.getMany.mockResolvedValue([post]);
    claimsQb.getMany.mockResolvedValue([claim]);
    swapsQb.getMany.mockResolvedValue([swap]);

    manager = {
      createQueryBuilder: jest
        .fn()
        .mockImplementationOnce(() => postsQb)
        .mockImplementationOnce(() => claimsQb)
        .mockImplementationOnce(() => swapsQb),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    service = new PendingMarketplaceActionsQueryService(dataSource as DataSource);
  });

  it('resolves posts for the org unit first, then filters claims by those post ids', async () => {
    await service.listForOrgUnit(TENANT_ID, ORG_UNIT_ID);

    expect(postsQb.where).toHaveBeenCalledWith('post.tenantId = :tenantId', { tenantId: TENANT_ID });
    expect(postsQb.andWhere).toHaveBeenCalledWith('post.orgUnitId = :orgUnitId', { orgUnitId: ORG_UNIT_ID });
    expect(claimsQb.andWhere).toHaveBeenCalledWith('claim.marketplacePostId IN (:...postIds)', {
      postIds: ['post-1'],
    });
    expect(claimsQb.andWhere).toHaveBeenCalledWith('claim.status = :status', {
      status: MarketplaceClaimStatus.PENDING_APPROVAL,
    });
  });

  it('filters swaps by initiator OR target org unit directly, with no post lookup needed', async () => {
    await service.listForOrgUnit(TENANT_ID, ORG_UNIT_ID);

    expect(swapsQb.andWhere).toHaveBeenCalledWith(
      '(swap.initiatorOrgUnitId = :orgUnitId OR swap.targetOrgUnitId = :orgUnitId)',
      { orgUnitId: ORG_UNIT_ID },
    );
    expect(swapsQb.andWhere).toHaveBeenCalledWith('swap.status = :status', {
      status: SwapRequestStatus.PENDING_APPROVAL,
    });
  });

  it('pairs each claim with its post', async () => {
    const result = await service.listForOrgUnit(TENANT_ID, ORG_UNIT_ID);

    expect(result.claims).toEqual([{ claim, post }]);
    expect(result.swaps).toEqual([swap]);
  });

  it('skips the claims query entirely when the org unit has no posts', async () => {
    postsQb.getMany.mockResolvedValue([]);

    const result = await service.listForOrgUnit(TENANT_ID, ORG_UNIT_ID);

    expect(result.claims).toEqual([]);
    // Only postsQb and swapsQb were asked for - createQueryBuilder was called twice, not three times.
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(2);
  });
});
