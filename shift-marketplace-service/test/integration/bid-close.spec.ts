import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { Bid, BidOpportunity, entities, MarketplaceClaim, MarketplacePost } from '../../src/database/entities';
import { BidRankingMethod } from '../../src/marketplace/entities/bid-opportunity.entity';
import { MarketplacePostStatus, MarketplacePostType } from '../../src/marketplace/entities/marketplace-post.entity';
import {
  MarketplaceClaimSource,
  MarketplaceClaimStatus,
} from '../../src/marketplace/entities/marketplace-claim.entity';
import { BidService } from '../../src/marketplace/bid.service';
import { GuardrailValidationService } from '../../src/marketplace/guardrail-validation.service';
import { EmployeeGrpcClientService } from '../../src/grpc/employee-grpc-client.service';
import { TenantMarketplacePolicyService } from '../../src/marketplace/tenant-marketplace-policy.service';
import { MarketplaceEventPublisherService } from '../../src/marketplace/marketplace-event-publisher.service';
import { MarketplaceEngagementService } from '../../src/marketplace/marketplace-engagement.service';
import { MetricsService } from '../../src/common/metrics/metrics.service';
import { MarketplaceRedisService } from '../../src/redis/redis.service';

dotenv.config();

/**
 * §5.1/§7's real-Postgres companion to `bid.service.spec.ts`'s mocked
 * unit tests - proves `BidService.submitBid`/`closeBidOpportunity` persist
 * correctly against the real schema/RLS/unique-constraint stack, same
 * "stub what this test doesn't own, keep real what it does" posture as
 * `claim-open-shift-concurrency.spec.ts`: `GuardrailValidationService` and
 * `EmployeeGrpcClientService` are stubbed (no real Module 02/04
 * dependency needed to prove the ranking/persistence behavior), Postgres
 * is the real thing.
 */
describe('BidService close (§5.1, real Postgres)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_marketplace_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

    migratorDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await migratorDataSource.initialize();
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  it('§5.1: every bidder (not just the winner) gets a real rank_position and rank_explanation on close, persisted to Postgres', async () => {
    const tenantId = randomUUID();
    const orgUnitId = randomUUID();
    const postId = randomUUID();
    const opportunityId = randomUUID();

    await migratorDataSource.getRepository(MarketplacePost).insert({
      id: postId,
      tenantId,
      postType: MarketplacePostType.BID,
      shiftAssignmentId: randomUUID(),
      orgUnitId,
      postedBy: null,
      status: MarketplacePostStatus.OPEN,
      eligibilityRules: {},
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
    });
    await migratorDataSource.getRepository(BidOpportunity).insert({
      id: opportunityId,
      tenantId,
      marketplacePostId: postId,
      biddingWindowStart: new Date(Date.now() - 3_600_000),
      biddingWindowEnd: new Date(Date.now() + 3_600_000),
      rankingMethod: BidRankingMethod.FIRST_COME,
    });

    const stubGuardrailValidation = {
      checkEligibility: async () => ({ shiftAssignmentFound: true, eligible: true, violations: [] }),
    } as unknown as GuardrailValidationService;
    const stubEmployeeGrpcClient = { getSchedulableRoster: async () => [] } as unknown as EmployeeGrpcClientService;
    // ADR-0159: same "stub what this test doesn't own" posture as the two
    // Module 02/04 stubs above - no real NATS/engagement-ledger dependency
    // needed to prove closeBidOpportunity's own Postgres writes (the claim,
    // the post flip) are real.
    const stubTenantPolicy = { isAutoApprovalEnabled: () => false } as unknown as TenantMarketplacePolicyService;
    const stubEventPublisher = {
      recordClaimApproved: async () => undefined,
    } as unknown as MarketplaceEventPublisherService;
    const stubEngagement = { recordEvent: async () => undefined } as unknown as MarketplaceEngagementService;
    const stubPubSub = { publish: async () => undefined } as unknown as PubSub;
    // Same "stub what this test doesn't own" posture - no real Redis
    // dependency needed to prove closeBidOpportunity's own Postgres writes;
    // a token is granted unconditionally, same as every other stub above.
    const stubRedis = {
      acquireClaimLock: async () => 'stub-lock-token',
      releaseClaimLock: async () => undefined,
    } as unknown as MarketplaceRedisService;
    const service = new BidService(
      appDataSource,
      stubGuardrailValidation,
      stubEmployeeGrpcClient,
      stubTenantPolicy,
      stubEventPublisher,
      stubEngagement,
      new MetricsService(),
      stubRedis,
      stubPubSub,
    );

    const bidderIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const employeeId of bidderIds) {
      await service.submitBid({ tenantId, bidOpportunityId: opportunityId, employeeId });
      await new Promise((resolve) => setTimeout(resolve, 5)); // distinct submittedAt ordering
    }

    // Duplicate bid from the same employee is rejected, not silently accepted.
    await expect(
      service.submitBid({ tenantId, bidOpportunityId: opportunityId, employeeId: bidderIds[0] }),
    ).rejects.toThrow(/already submitted a bid/);

    const closed = await service.closeBidOpportunity(tenantId, opportunityId);

    expect(closed).toHaveLength(3);
    const positions = closed.map((b) => b.rankPosition).sort();
    expect(positions).toEqual([1, 2, 3]);
    expect(closed.every((b) => b.rankExplanation !== null)).toBe(true);

    // Re-close is rejected, not silently re-ranked.
    await expect(service.closeBidOpportunity(tenantId, opportunityId)).rejects.toThrow(/already been closed/);

    // And it's really committed to Postgres, not just returned in-memory.
    const persisted = await migratorDataSource.getRepository(Bid).find({ where: { bidOpportunityId: opportunityId } });
    expect(persisted.every((b) => b.rankPosition !== null && b.rankExplanation !== null)).toBe(true);

    // ADR-0159: the winner (rank 1) is now a real, persisted MarketplaceClaim
    // with source: bid, and the post it came from really flipped to claimed
    // - not just computed rank transparency.
    const winner = closed.find((b) => b.rankPosition === 1)!;
    const claims = await migratorDataSource
      .getRepository(MarketplaceClaim)
      .find({ where: { marketplacePostId: postId } });
    expect(claims).toHaveLength(1);
    expect(claims[0].claimantEmployeeId).toBe(winner.employeeId);
    expect(claims[0].source).toBe(MarketplaceClaimSource.BID);
    expect(claims[0].status).toBe(MarketplaceClaimStatus.PENDING_APPROVAL);

    const closedPost = await migratorDataSource.getRepository(MarketplacePost).findOneOrFail({ where: { id: postId } });
    expect(closedPost.status).toBe(MarketplacePostStatus.CLAIMED);
  }, 30000);
});
