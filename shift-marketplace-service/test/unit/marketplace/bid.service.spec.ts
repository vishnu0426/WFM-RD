import { DataSource, EntityManager } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { BidService } from '../../../src/marketplace/bid.service';
import { GuardrailValidationService } from '../../../src/marketplace/guardrail-validation.service';
import { EmployeeGrpcClientService } from '../../../src/grpc/employee-grpc-client.service';
import { TenantMarketplacePolicyService } from '../../../src/marketplace/tenant-marketplace-policy.service';
import { MarketplaceEventPublisherService } from '../../../src/marketplace/marketplace-event-publisher.service';
import { MarketplaceEngagementService } from '../../../src/marketplace/marketplace-engagement.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { MarketplaceRedisService, MarketplaceRedisUnavailableError } from '../../../src/redis/redis.service';
import { Bid } from '../../../src/marketplace/entities/bid.entity';
import { BidOpportunity, BidRankingMethod } from '../../../src/marketplace/entities/bid-opportunity.entity';
import {
  MarketplacePost,
  MarketplacePostStatus,
  MarketplacePostType,
} from '../../../src/marketplace/entities/marketplace-post.entity';
import { MarketplaceClaim, MarketplaceClaimSource } from '../../../src/marketplace/entities/marketplace-claim.entity';
import { BidOpportunityNotFoundError } from '../../../src/marketplace/errors/bid-opportunity-not-found.error';
import { BiddingWindowNotOpenError } from '../../../src/marketplace/errors/bidding-window-not-open.error';
import { BidderNotEligibleError } from '../../../src/marketplace/errors/bidder-not-eligible.error';
import { PreferenceScoreRequiredError } from '../../../src/marketplace/errors/preference-score-required.error';
import { AlreadyBidError } from '../../../src/marketplace/errors/already-bid.error';
import { BidOpportunityAlreadyClosedError } from '../../../src/marketplace/errors/bid-opportunity-already-closed.error';

const TENANT_ID = 'tenant-1';
const OPPORTUNITY_ID = 'opportunity-1';
const POST_ID = 'post-1';
const EMPLOYEE_ID = 'employee-1';

function opportunity(overrides: Partial<BidOpportunity> = {}): BidOpportunity {
  return {
    id: OPPORTUNITY_ID,
    tenantId: TENANT_ID,
    marketplacePostId: POST_ID,
    biddingWindowStart: new Date(Date.now() - 3600_000),
    biddingWindowEnd: new Date(Date.now() + 3600_000),
    rankingMethod: BidRankingMethod.FIRST_COME,
    ...overrides,
  };
}

function post(overrides: Partial<MarketplacePost> = {}): MarketplacePost {
  return {
    id: POST_ID,
    tenantId: TENANT_ID,
    postType: MarketplacePostType.BID,
    shiftAssignmentId: 'shift-1',
    orgUnitId: 'org-1',
    postedBy: null,
    status: MarketplacePostStatus.OPEN,
    eligibilityRules: {},
    expiresAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

describe('BidService (§8 Phase 4, ADR-0159)', () => {
  let dataSource: Partial<DataSource>;
  let manager: {
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    query: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let bidQueryBuilder: { where: jest.Mock; andWhere: jest.Mock; orderBy: jest.Mock; getMany: jest.Mock };
  let guardrailValidation: { checkEligibility: jest.Mock };
  let employeeGrpcClient: { getSchedulableRoster: jest.Mock };
  let tenantPolicy: { isAutoApprovalEnabled: jest.Mock };
  let eventPublisher: { recordClaimApproved: jest.Mock };
  let engagement: { recordEvent: jest.Mock };
  let pubSub: { publish: jest.Mock };
  let metrics: MetricsService;
  let redis: { acquireClaimLock: jest.Mock; releaseClaimLock: jest.Mock };
  let currentOpportunity: BidOpportunity;
  let currentPost: MarketplacePost;
  let bids: Bid[];
  let service: BidService;

  beforeEach(() => {
    currentOpportunity = opportunity();
    currentPost = post();
    bids = [];

    bidQueryBuilder = { where: jest.fn(), andWhere: jest.fn(), orderBy: jest.fn(), getMany: jest.fn() };
    bidQueryBuilder.where.mockReturnValue(bidQueryBuilder);
    bidQueryBuilder.andWhere.mockReturnValue(bidQueryBuilder);
    bidQueryBuilder.orderBy.mockReturnValue(bidQueryBuilder);
    bidQueryBuilder.getMany.mockResolvedValue([]);

    manager = {
      // GAP-01: `convertWinningBidToClaim`'s post-status flip now runs a raw
      // conditional UPDATE ... RETURNING through `manager.query` - default
      // to "the conditional UPDATE matched" so every pre-existing
      // happy-path test keeps its original behavior unchanged. TypeORM's
      // `EntityManager.query()` returns `[rows, rowCount]` for an UPDATE
      // (even with RETURNING), not the rows array directly - see
      // claim-open-shift.service.spec.ts's identical mock for the full
      // explanation of why this shape matters.
      query: jest.fn().mockResolvedValue([[{ id: 'post-1' }], 1]),
      delete: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(bidQueryBuilder),
      findOne: jest.fn(async (entity: unknown) => {
        if (entity === BidOpportunity) return currentOpportunity;
        if (entity === MarketplacePost) return currentPost;
        return null;
      }),
      findOneOrFail: jest.fn(async (entity: unknown) =>
        entity === MarketplacePost ? currentPost : currentOpportunity,
      ),
      find: jest.fn(async () => bids),
      create: jest.fn((_entity: unknown, values: unknown) => values),
      save: jest.fn(async (value: Bid | MarketplacePost | MarketplaceClaim) => {
        if ('postType' in value) {
          currentPost = value;
        } else if ('bidOpportunityId' in value) {
          const idx = bids.findIndex((b) => b.id === value.id);
          if (idx >= 0) bids[idx] = value;
          else bids.push(value);
        }
        return value;
      }),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    guardrailValidation = {
      checkEligibility: jest.fn().mockResolvedValue({ shiftAssignmentFound: true, eligible: true, violations: [] }),
    };
    employeeGrpcClient = { getSchedulableRoster: jest.fn().mockResolvedValue([]) };
    tenantPolicy = { isAutoApprovalEnabled: jest.fn().mockReturnValue(false) };
    eventPublisher = { recordClaimApproved: jest.fn().mockResolvedValue(undefined) };
    engagement = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    pubSub = { publish: jest.fn().mockResolvedValue(undefined) };
    metrics = new MetricsService();
    redis = {
      acquireClaimLock: jest.fn().mockResolvedValue('lock-token-1'),
      releaseClaimLock: jest.fn().mockResolvedValue(undefined),
    };

    service = new BidService(
      dataSource as DataSource,
      guardrailValidation as unknown as GuardrailValidationService,
      employeeGrpcClient as unknown as EmployeeGrpcClientService,
      tenantPolicy as unknown as TenantMarketplacePolicyService,
      eventPublisher as unknown as MarketplaceEventPublisherService,
      engagement as unknown as MarketplaceEngagementService,
      metrics,
      redis as unknown as MarketplaceRedisService,
      pubSub as unknown as PubSub,
    );
  });

  describe('submitBid', () => {
    it('throws BidOpportunityNotFoundError when the opportunity does not exist', async () => {
      manager.findOne.mockResolvedValue(null);

      await expect(
        service.submitBid({ tenantId: TENANT_ID, bidOpportunityId: OPPORTUNITY_ID, employeeId: EMPLOYEE_ID }),
      ).rejects.toBeInstanceOf(BidOpportunityNotFoundError);
    });

    it('throws BiddingWindowNotOpenError(not_yet_open) before the window starts', async () => {
      currentOpportunity = opportunity({ biddingWindowStart: new Date(Date.now() + 3600_000) });

      await expect(
        service.submitBid({ tenantId: TENANT_ID, bidOpportunityId: OPPORTUNITY_ID, employeeId: EMPLOYEE_ID }),
      ).rejects.toBeInstanceOf(BiddingWindowNotOpenError);
    });

    it('throws BiddingWindowNotOpenError(closed) after the window ends', async () => {
      currentOpportunity = opportunity({ biddingWindowEnd: new Date(Date.now() - 1000) });

      await expect(
        service.submitBid({ tenantId: TENANT_ID, bidOpportunityId: OPPORTUNITY_ID, employeeId: EMPLOYEE_ID }),
      ).rejects.toBeInstanceOf(BiddingWindowNotOpenError);
    });

    it('requires a preferenceScore when the ranking method is preference_score, before any guardrail call', async () => {
      currentOpportunity = opportunity({ rankingMethod: BidRankingMethod.PREFERENCE_SCORE });

      await expect(
        service.submitBid({ tenantId: TENANT_ID, bidOpportunityId: OPPORTUNITY_ID, employeeId: EMPLOYEE_ID }),
      ).rejects.toBeInstanceOf(PreferenceScoreRequiredError);
      expect(guardrailValidation.checkEligibility).not.toHaveBeenCalled();
    });

    it('§0 non-negotiable: an ineligible bidder never gets a live bid', async () => {
      guardrailValidation.checkEligibility.mockResolvedValue({
        shiftAssignmentFound: true,
        eligible: false,
        violations: [],
      });

      await expect(
        service.submitBid({ tenantId: TENANT_ID, bidOpportunityId: OPPORTUNITY_ID, employeeId: EMPLOYEE_ID }),
      ).rejects.toBeInstanceOf(BidderNotEligibleError);
      expect(bids).toHaveLength(0);
    });

    it('stores the submitted preferenceScore as rankScore for preference_score opportunities', async () => {
      currentOpportunity = opportunity({ rankingMethod: BidRankingMethod.PREFERENCE_SCORE });

      const bid = await service.submitBid({
        tenantId: TENANT_ID,
        bidOpportunityId: OPPORTUNITY_ID,
        employeeId: EMPLOYEE_ID,
        preferenceScore: 7,
      });

      expect(bid.rankScore).toBe('7');
      expect(bid.rankPosition).toBeNull();
    });

    it('translates a unique-violation on duplicate bid into AlreadyBidError', async () => {
      manager.save.mockRejectedValueOnce({ code: '23505' });

      await expect(
        service.submitBid({ tenantId: TENANT_ID, bidOpportunityId: OPPORTUNITY_ID, employeeId: EMPLOYEE_ID }),
      ).rejects.toBeInstanceOf(AlreadyBidError);
    });
  });

  describe('findAllByOpportunity (Shift Marketplace Manager View phase, §4)', () => {
    it('filters by tenant and bidOpportunityId, ordered by rankPosition ascending with nulls last', async () => {
      bidQueryBuilder.getMany.mockResolvedValue([]);

      await service.findAllByOpportunity(TENANT_ID, OPPORTUNITY_ID);

      expect(bidQueryBuilder.where).toHaveBeenCalledWith('bid.tenantId = :tenantId', { tenantId: TENANT_ID });
      expect(bidQueryBuilder.andWhere).toHaveBeenCalledWith('bid.bidOpportunityId = :bidOpportunityId', {
        bidOpportunityId: OPPORTUNITY_ID,
      });
      expect(bidQueryBuilder.orderBy).toHaveBeenCalledWith('bid.rankPosition', 'ASC', 'NULLS LAST');
    });

    it('returns every bid the query produces, not just the winner', async () => {
      function bidRow(id: string, rankPosition: number): Bid {
        return {
          id,
          tenantId: TENANT_ID,
          bidOpportunityId: OPPORTUNITY_ID,
          employeeId: `employee-${id}`,
          rankScore: null,
          rankPosition,
          rankExplanation: { method: 'first_come', yourPosition: rankPosition, totalBidders: 2 },
          submittedAt: new Date(),
        };
      }
      const rows = [bidRow('bid-1', 1), bidRow('bid-2', 2)];
      bidQueryBuilder.getMany.mockResolvedValue(rows);

      const result = await service.findAllByOpportunity(TENANT_ID, OPPORTUNITY_ID);

      expect(result).toEqual(rows);
    });
  });

  describe('closeBidOpportunity', () => {
    it('throws BidOpportunityAlreadyClosedError if any bid already has a rank position', async () => {
      bids = [
        {
          id: 'b1',
          tenantId: TENANT_ID,
          bidOpportunityId: OPPORTUNITY_ID,
          employeeId: 'e1',
          rankScore: null,
          rankPosition: 1,
          rankExplanation: {},
          submittedAt: new Date(),
        },
      ];

      await expect(service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID)).rejects.toBeInstanceOf(
        BidOpportunityAlreadyClosedError,
      );
    });

    it('returns an empty array with no bids to rank', async () => {
      const result = await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);
      expect(result).toEqual([]);
    });

    it('ranks every bid by first_come and persists rank_position/rank_explanation for all of them', async () => {
      bids = [
        {
          id: 'b1',
          tenantId: TENANT_ID,
          bidOpportunityId: OPPORTUNITY_ID,
          employeeId: 'e1',
          rankScore: null,
          rankPosition: null,
          rankExplanation: null,
          submittedAt: new Date('2026-01-01T10:00:00Z'),
        },
        {
          id: 'b2',
          tenantId: TENANT_ID,
          bidOpportunityId: OPPORTUNITY_ID,
          employeeId: 'e2',
          rankScore: null,
          rankPosition: null,
          rankExplanation: null,
          submittedAt: new Date('2026-01-01T09:00:00Z'),
        },
      ];

      const result = await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

      expect(result.find((b) => b.id === 'b2')?.rankPosition).toBe(1);
      expect(result.find((b) => b.id === 'b1')?.rankPosition).toBe(2);
      expect(result.every((b) => b.rankExplanation !== null)).toBe(true);
    });

    it('fetches the org unit roster from Module 02 only for seniority ranking', async () => {
      currentOpportunity = opportunity({ rankingMethod: BidRankingMethod.SENIORITY });
      bids = [
        {
          id: 'b1',
          tenantId: TENANT_ID,
          bidOpportunityId: OPPORTUNITY_ID,
          employeeId: EMPLOYEE_ID,
          rankScore: null,
          rankPosition: null,
          rankExplanation: null,
          submittedAt: new Date(),
        },
      ];

      await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

      expect(employeeGrpcClient.getSchedulableRoster).toHaveBeenCalledWith(TENANT_ID, currentPost.orgUnitId);
    });

    describe('ADR-0159: converting the winning bid into a real claim', () => {
      function singleBid(overrides: Partial<Bid> = {}): Bid {
        return {
          id: 'b1',
          tenantId: TENANT_ID,
          bidOpportunityId: OPPORTUNITY_ID,
          employeeId: EMPLOYEE_ID,
          rankScore: null,
          rankPosition: null,
          rankExplanation: null,
          submittedAt: new Date(),
          ...overrides,
        };
      }

      it('re-validates the winner, flips the post to claimed, and (no tenant auto-approval) leaves the claim pending_approval without notifying Module 04 yet', async () => {
        bids = [singleBid()];

        await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

        expect(guardrailValidation.checkEligibility).toHaveBeenCalledWith({
          tenantId: TENANT_ID,
          candidateEmployeeId: EMPLOYEE_ID,
          shiftAssignmentId: currentPost.shiftAssignmentId,
          orgUnitId: currentPost.orgUnitId,
        });
        expect(currentPost.status).toBe(MarketplacePostStatus.CLAIMED);
        expect(pubSub.publish).toHaveBeenCalledTimes(1);
        expect(eventPublisher.recordClaimApproved).not.toHaveBeenCalled();
        expect(engagement.recordEvent).not.toHaveBeenCalled();
      });

      it('with tenant auto-approval enabled, approves the claim, notifies Module 04 with source: bid, and awards engagement points', async () => {
        tenantPolicy.isAutoApprovalEnabled.mockReturnValue(true);
        bids = [singleBid()];

        await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

        expect(eventPublisher.recordClaimApproved).toHaveBeenCalledWith(manager, {
          tenantId: TENANT_ID,
          marketplaceClaimId: expect.any(String),
          marketplacePostId: currentPost.id,
          shiftAssignmentId: currentPost.shiftAssignmentId,
          claimantEmployeeId: EMPLOYEE_ID,
          approvedBy: null,
          source: MarketplaceClaimSource.BID,
        });
        expect(engagement.recordEvent).toHaveBeenCalledWith({
          tenantId: TENANT_ID,
          employeeId: EMPLOYEE_ID,
          eventType: 'claim_approved',
          referenceId: expect.any(String),
        });
      });

      it('does not convert, and does not touch the post, when the post is no longer open', async () => {
        currentPost = post({ status: MarketplacePostStatus.EXPIRED });
        bids = [singleBid()];

        await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

        expect(guardrailValidation.checkEligibility).not.toHaveBeenCalled();
        expect(currentPost.status).toBe(MarketplacePostStatus.EXPIRED);
        expect(pubSub.publish).not.toHaveBeenCalled();
      });

      it('does not convert when the winner fails re-validation at close time, but the ranking itself still succeeded', async () => {
        guardrailValidation.checkEligibility.mockResolvedValue({
          shiftAssignmentFound: true,
          eligible: false,
          violations: [{ category: 'min_rest', detail: 'conflicts with an existing assignment' }],
        });
        bids = [singleBid()];

        const result = await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

        expect(result[0].rankPosition).toBe(1);
        expect(currentPost.status).toBe(MarketplacePostStatus.OPEN);
        expect(pubSub.publish).not.toHaveBeenCalled();
        expect(eventPublisher.recordClaimApproved).not.toHaveBeenCalled();
      });

      it('does not convert when guardrail validation is unavailable, but still returns the ranked bids', async () => {
        guardrailValidation.checkEligibility.mockRejectedValue(new Error('gRPC unavailable'));
        bids = [singleBid()];

        const result = await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

        expect(result[0].rankPosition).toBe(1);
        expect(currentPost.status).toBe(MarketplacePostStatus.OPEN);
        expect(eventPublisher.recordClaimApproved).not.toHaveBeenCalled();
      });

      it('never attempts conversion when nobody bid', async () => {
        await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

        expect(guardrailValidation.checkEligibility).not.toHaveBeenCalled();
        expect(eventPublisher.recordClaimApproved).not.toHaveBeenCalled();
      });

      it('acquires the same contention lock claimOpenShift uses, on the post, before touching it - and releases it afterwards', async () => {
        bids = [singleBid()];

        await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

        expect(redis.acquireClaimLock).toHaveBeenCalledWith(TENANT_ID, POST_ID, 5);
        expect(redis.releaseClaimLock).toHaveBeenCalledWith(TENANT_ID, POST_ID, 'lock-token-1');
        // Acquired before the post/guardrail work, released after - proven
        // by call order, not just "both were called."
        const acquireOrder = redis.acquireClaimLock.mock.invocationCallOrder[0];
        const findOrder = manager.findOne.mock.invocationCallOrder.find((o: number) => o > acquireOrder);
        expect(findOrder).toBeDefined();
      });

      it('does not convert, and never touches the post, when it loses the lock to a concurrent claim/swap', async () => {
        redis.acquireClaimLock.mockResolvedValue(null);
        bids = [singleBid()];

        const result = await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

        expect(result[0].rankPosition).toBe(1);
        expect(manager.findOne).not.toHaveBeenCalledWith(MarketplacePost, expect.anything());
        expect(guardrailValidation.checkEligibility).not.toHaveBeenCalled();
        expect(eventPublisher.recordClaimApproved).not.toHaveBeenCalled();
        expect(redis.releaseClaimLock).not.toHaveBeenCalled();
      });

      it('does not convert when Redis is unreachable, and still returns the ranked bids', async () => {
        redis.acquireClaimLock.mockRejectedValue(
          new MarketplaceRedisUnavailableError('acquireClaimLock', new Error('ECONNREFUSED')),
        );
        bids = [singleBid()];

        const result = await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

        expect(result[0].rankPosition).toBe(1);
        expect(guardrailValidation.checkEligibility).not.toHaveBeenCalled();
        expect(eventPublisher.recordClaimApproved).not.toHaveBeenCalled();
      });

      it('still releases the lock when guardrail re-validation rejects the winner', async () => {
        guardrailValidation.checkEligibility.mockResolvedValue({
          shiftAssignmentFound: true,
          eligible: false,
          violations: [],
        });
        bids = [singleBid()];

        await service.closeBidOpportunity(TENANT_ID, OPPORTUNITY_ID);

        expect(redis.releaseClaimLock).toHaveBeenCalledWith(TENANT_ID, POST_ID, 'lock-token-1');
      });
    });
  });
});
