import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { PubSub } from 'graphql-subscriptions';
import { entities, MarketplaceClaim, MarketplacePost } from '../../src/database/entities';
import { MarketplaceClaimStatus } from '../../src/marketplace/entities/marketplace-claim.entity';
import { MarketplacePostStatus, MarketplacePostType } from '../../src/marketplace/entities/marketplace-post.entity';
import { ClaimOpenShiftService } from '../../src/marketplace/claim-open-shift.service';
import { GuardrailValidationService } from '../../src/marketplace/guardrail-validation.service';
import { MarketplaceRedisService } from '../../src/redis/redis.service';
import { MetricsService } from '../../src/common/metrics/metrics.service';
import { PostAlreadyBeingClaimedError } from '../../src/marketplace/errors/post-already-being-claimed.error';
import { TenantMarketplacePolicyService } from '../../src/marketplace/tenant-marketplace-policy.service';
import { MarketplaceEventPublisherService } from '../../src/marketplace/marketplace-event-publisher.service';
import { ClaimAttemptRateLimiterService } from '../../src/marketplace/claim-attempt-rate-limiter.service';
import { MarketplaceEngagementService } from '../../src/marketplace/marketplace-engagement.service';

dotenv.config();

/**
 * §7's own dedicated deliverable: "a concurrency test simulating N
 * simultaneous claim attempts on one post - assert exactly one wins, all
 * others get the immediate fast-fail response within SLO, and the post
 * ends in a consistent state." Requires a reachable Postgres (Phase 1's
 * migration already applied, `npm run migration:run`) *and* a reachable
 * Redis - this is the one test in this module that cannot be meaningfully
 * faked with a mock, since the property under test is Redis's own atomic
 * `SET NX` behavior under genuine concurrent access, not this service's
 * business logic in isolation. Same "stub what this test doesn't own,
 * keep real what it does" posture as attendance-leave-service's own
 * `leave-request-concurrency.spec.ts`: `GuardrailValidationService` is
 * stubbed (always eligible, no real gRPC dependency), the GraphQL PubSub
 * is a real in-process `PubSub` (cheap, no reason to stub), but the Redis
 * lock and the Postgres transactions are the real thing.
 */
describe('ClaimOpenShiftService concurrency (§4/§7, ADR-0085)', () => {
  let appDataSource: DataSource; // agno_marketplace_app, same role the running application uses
  let migratorDataSource: DataSource; // fixture seeding only
  let redisClient: Redis;

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

    redisClient = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
    });
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
    redisClient.disconnect();
  });

  it('exactly one of N genuinely concurrent claim attempts on the same post wins, fast-fail within SLO, post ends consistent', async () => {
    const tenantId = randomUUID();
    const orgUnitId = randomUUID();
    const postId = randomUUID();
    const shiftAssignmentId = randomUUID();
    const N = 20;

    await migratorDataSource.getRepository(MarketplacePost).insert({
      id: postId,
      tenantId,
      postType: MarketplacePostType.OPEN_SHIFT,
      shiftAssignmentId,
      orgUnitId,
      postedBy: null,
      status: MarketplacePostStatus.OPEN,
      eligibilityRules: {},
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
    });

    const metrics = new MetricsService();
    const redis = new MarketplaceRedisService(redisClient, metrics);
    const pubSub = new PubSub();
    const stubGuardrailValidation = {
      checkEligibility: async () => ({ shiftAssignmentFound: true, eligible: true, violations: [] }),
    } as unknown as GuardrailValidationService;
    const stubTenantPolicy = { isAutoApprovalEnabled: () => false } as unknown as TenantMarketplacePolicyService;
    const stubEventPublisher = {
      recordClaimApproved: async () => undefined,
    } as unknown as MarketplaceEventPublisherService;
    // §7's own concern here is Redis's atomic SET NX under real concurrency,
    // not §5.2's rate limiter (each claimant below is a distinct random
    // employee id, so the real limiter would never fire anyway) - stubbed
    // out for the same reason GuardrailValidationService is.
    const stubRateLimiter = {
      assertNotRateLimited: async () => undefined,
      recordFailedAttempt: async () => undefined,
    } as unknown as ClaimAttemptRateLimiterService;
    // This test's tenant auto-approval policy is always off (stubTenantPolicy
    // above), so every claim here lands in `pending_approval`, never
    // `approved` - the real engagement service would never be called either
    // way; stubbed purely to satisfy the constructor.
    const stubEngagement = { recordEvent: async () => undefined } as unknown as MarketplaceEngagementService;

    const service = new ClaimOpenShiftService(
      appDataSource,
      redis,
      stubGuardrailValidation,
      metrics,
      stubTenantPolicy,
      stubEventPublisher,
      stubRateLimiter,
      stubEngagement,
      pubSub,
    );

    const claimantIds = Array.from({ length: N }, () => randomUUID());
    const startedAt = process.hrtime.bigint();
    const results = await Promise.allSettled(
      claimantIds.map((claimantId) => service.claim(tenantId, postId, claimantId)),
    );
    const wallClockMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof service.claim>>> => r.status === 'fulfilled',
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    // Exactly one attempt reaches a real validated claim.
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].value.claim.status).toBe(MarketplaceClaimStatus.PENDING_APPROVAL);
    expect(fulfilled[0].value.post.status).toBe(MarketplacePostStatus.CLAIMED);

    // Every other attempt gets the immediate lock-loser fast-fail, not a
    // validation-pipeline error, a timeout, or a database error.
    expect(rejected).toHaveLength(N - 1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(PostAlreadyBeingClaimedError);
    }

    // §0.5's SLO is about lock acquisition specifically, but this is a
    // reasonable proxy at N=20 on a local Redis: if the lock were falling
    // back to serializing losers behind the winner's full validation
    // round-trip (the exact anti-pattern §4 step 3 forbids) instead of
    // fast-failing them immediately, this would be far slower than one
    // claim's own processing time.
    expect(wallClockMs).toBeLessThan(2000);

    // The post ends in a consistent state: exactly one MarketplaceClaim
    // reached pending_approval, the rest are rejected-or-absent, and the
    // post itself is claimed - no double-write, no lost update.
    const claims = await migratorDataSource
      .getRepository(MarketplaceClaim)
      .find({ where: { marketplacePostId: postId } });
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe(MarketplaceClaimStatus.PENDING_APPROVAL);

    const finalPost = await migratorDataSource.getRepository(MarketplacePost).findOneOrFail({ where: { id: postId } });
    expect(finalPost.status).toBe(MarketplacePostStatus.CLAIMED);
  }, 30000);
});
