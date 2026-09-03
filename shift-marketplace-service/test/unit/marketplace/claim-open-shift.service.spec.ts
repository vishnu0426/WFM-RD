import { DataSource, EntityManager } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { ClaimOpenShiftService } from '../../../src/marketplace/claim-open-shift.service';
import { GuardrailValidationService } from '../../../src/marketplace/guardrail-validation.service';
import { MarketplaceRedisService, MarketplaceRedisUnavailableError } from '../../../src/redis/redis.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import {
  MarketplacePost,
  MarketplacePostStatus,
  MarketplacePostType,
} from '../../../src/marketplace/entities/marketplace-post.entity';
import {
  MarketplaceClaim,
  MarketplaceClaimSource,
  MarketplaceClaimStatus,
} from '../../../src/marketplace/entities/marketplace-claim.entity';
import { MarketplacePostNotFoundError } from '../../../src/marketplace/errors/marketplace-post-not-found.error';
import { PostNotOpenError } from '../../../src/marketplace/errors/post-not-open.error';
import { PostAlreadyBeingClaimedError } from '../../../src/marketplace/errors/post-already-being-claimed.error';
import { MarketplaceUnavailableError } from '../../../src/marketplace/errors/marketplace-unavailable.error';
import { GuardrailValidationUnavailableError } from '../../../src/marketplace/errors/guardrail-validation-unavailable.error';
import { TenantMarketplacePolicyService } from '../../../src/marketplace/tenant-marketplace-policy.service';
import { MarketplaceEventPublisherService } from '../../../src/marketplace/marketplace-event-publisher.service';
import { ClaimAttemptRateLimiterService } from '../../../src/marketplace/claim-attempt-rate-limiter.service';
import { ClaimAttemptRateLimitExceededError } from '../../../src/marketplace/errors/claim-attempt-rate-limit-exceeded.error';
import { MarketplaceEngagementService } from '../../../src/marketplace/marketplace-engagement.service';

const TENANT_ID = 'tenant-1';
const POST_ID = 'post-1';
const CLAIMANT_ID = 'employee-1';

function post(overrides: Partial<MarketplacePost> = {}): MarketplacePost {
  return {
    id: POST_ID,
    tenantId: TENANT_ID,
    postType: MarketplacePostType.OPEN_SHIFT,
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

function claimRow(overrides: Partial<MarketplaceClaim> = {}): MarketplaceClaim {
  return {
    id: 'claim-1',
    tenantId: TENANT_ID,
    marketplacePostId: POST_ID,
    claimantEmployeeId: CLAIMANT_ID,
    status: MarketplaceClaimStatus.PENDING_VALIDATION,
    source: MarketplaceClaimSource.OPEN_SHIFT_CLAIM,
    validationResult: null,
    claimedAt: new Date(),
    decisionReason: null,
    ...overrides,
  };
}

describe('ClaimOpenShiftService (§4/ADR-0085)', () => {
  let dataSource: Partial<DataSource>;
  let manager: {
    query: jest.Mock;
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let redis: { acquireClaimLock: jest.Mock; releaseClaimLock: jest.Mock };
  let guardrailValidation: { checkEligibility: jest.Mock };
  let pubSub: { publish: jest.Mock };
  let metrics: MetricsService;
  let tenantPolicy: { isAutoApprovalEnabled: jest.Mock };
  let eventPublisher: { recordClaimApproved: jest.Mock };
  let rateLimiter: { assertNotRateLimited: jest.Mock; recordFailedAttempt: jest.Mock };
  let engagement: { recordEvent: jest.Mock };
  let currentPost: MarketplacePost;
  let currentClaim: MarketplaceClaim;
  let service: ClaimOpenShiftService;

  beforeEach(() => {
    currentPost = post();
    currentClaim = claimRow();

    manager = {
      // GAP-01: `processClaim`'s post-status flip now runs a raw conditional
      // UPDATE ... RETURNING through `manager.query` (see `redis-lost-race`
      // tests below for the "lost the DB race" override) - default to "the
      // conditional UPDATE matched" so every pre-existing happy-path test
      // keeps its original behavior unchanged. TypeORM's `EntityManager.query()`
      // returns `[rows, rowCount]` for an UPDATE (even with RETURNING), not
      // the rows array directly - the mock must match that real shape or it
      // validates nothing (confirmed the hard way: this mock originally
      // returned `[{ id: POST_ID }]` directly, which let a bug where the
      // production code didn't destructure the tuple pass every unit test
      // while being wrong against real Postgres).
      query: jest.fn().mockResolvedValue([[{ id: POST_ID }], 1]),
      findOne: jest.fn(async (entity: unknown) => (entity === MarketplacePost ? currentPost : null)),
      findOneOrFail: jest.fn(async (entity: unknown) => (entity === MarketplacePost ? currentPost : currentClaim)),
      create: jest.fn((_entity: unknown, values: MarketplaceClaim) => {
        currentClaim = values;
        return values;
      }),
      save: jest.fn(async (value: MarketplacePost | MarketplaceClaim) => {
        if ('postType' in value) {
          currentPost = value;
        } else {
          currentClaim = value;
        }
        return value;
      }),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };

    redis = {
      acquireClaimLock: jest.fn().mockResolvedValue('token-1'),
      releaseClaimLock: jest.fn().mockResolvedValue(undefined),
    };
    guardrailValidation = {
      checkEligibility: jest.fn().mockResolvedValue({ shiftAssignmentFound: true, eligible: true, violations: [] }),
    };
    pubSub = { publish: jest.fn().mockResolvedValue(undefined) };
    metrics = new MetricsService();
    tenantPolicy = { isAutoApprovalEnabled: jest.fn().mockReturnValue(false) };
    eventPublisher = { recordClaimApproved: jest.fn().mockResolvedValue(undefined) };
    rateLimiter = {
      assertNotRateLimited: jest.fn().mockResolvedValue(undefined),
      recordFailedAttempt: jest.fn().mockResolvedValue(undefined),
    };
    engagement = { recordEvent: jest.fn().mockResolvedValue(undefined) };

    service = new ClaimOpenShiftService(
      dataSource as DataSource,
      redis as unknown as MarketplaceRedisService,
      guardrailValidation as unknown as GuardrailValidationService,
      metrics,
      tenantPolicy as unknown as TenantMarketplacePolicyService,
      eventPublisher as unknown as MarketplaceEventPublisherService,
      rateLimiter as unknown as ClaimAttemptRateLimiterService,
      engagement as unknown as MarketplaceEngagementService,
      pubSub as unknown as PubSub,
    );
  });

  it('§0.5 Redis chaos: fails closed with MarketplaceUnavailableError when Redis is unreachable, never falls back to an unlocked write', async () => {
    redis.acquireClaimLock.mockRejectedValue(
      new MarketplaceRedisUnavailableError('acquireClaimLock', new Error('ECONNREFUSED')),
    );

    await expect(service.claim(TENANT_ID, POST_ID, CLAIMANT_ID)).rejects.toBeInstanceOf(MarketplaceUnavailableError);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('§4 step 3: the lock loser gets an immediate, distinct fast-fail - never reaches the database at all', async () => {
    redis.acquireClaimLock.mockResolvedValue(null);

    await expect(service.claim(TENANT_ID, POST_ID, CLAIMANT_ID)).rejects.toBeInstanceOf(PostAlreadyBeingClaimedError);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(redis.releaseClaimLock).not.toHaveBeenCalled();
  });

  it('throws MarketplacePostNotFoundError and still releases the lock when the post does not exist', async () => {
    manager.findOne.mockResolvedValue(null);

    await expect(service.claim(TENANT_ID, POST_ID, CLAIMANT_ID)).rejects.toBeInstanceOf(MarketplacePostNotFoundError);
    expect(redis.releaseClaimLock).toHaveBeenCalledWith(TENANT_ID, POST_ID, 'token-1');
  });

  it('throws PostNotOpenError when the post is not open, and never calls guardrail validation', async () => {
    currentPost = post({ status: MarketplacePostStatus.CLAIMED });
    manager.findOne.mockResolvedValue(currentPost);

    await expect(service.claim(TENANT_ID, POST_ID, CLAIMANT_ID)).rejects.toBeInstanceOf(PostNotOpenError);
    expect(guardrailValidation.checkEligibility).not.toHaveBeenCalled();
  });

  it('§0.5 guardrail-gRPC chaos: fails closed, marks the claim rejected (not stuck pending_validation), and releases the lock', async () => {
    guardrailValidation.checkEligibility.mockRejectedValue(new GuardrailValidationUnavailableError());

    await expect(service.claim(TENANT_ID, POST_ID, CLAIMANT_ID)).rejects.toBeInstanceOf(
      GuardrailValidationUnavailableError,
    );
    expect(currentClaim.status).toBe(MarketplaceClaimStatus.REJECTED);
    expect(currentClaim.validationResult).toEqual({ eligible: false, reason: 'guardrail_validation_unavailable' });
    expect(currentPost.status).toBe(MarketplacePostStatus.OPEN);
    expect(redis.releaseClaimLock).toHaveBeenCalledWith(TENANT_ID, POST_ID, 'token-1');
  });

  it('§4 step 5: an ineligible claim is rejected with structured violations, and the post stays open (claimable again immediately)', async () => {
    guardrailValidation.checkEligibility.mockResolvedValue({
      shiftAssignmentFound: true,
      eligible: false,
      violations: [{ category: 'min_rest', detail: 'conflicts with an existing assignment' }],
    });

    const { claim, post: resultPost } = await service.claim(TENANT_ID, POST_ID, CLAIMANT_ID);

    expect(claim.status).toBe(MarketplaceClaimStatus.REJECTED);
    expect(claim.validationResult).toEqual({
      eligible: false,
      violations: [{ category: 'min_rest', detail: 'conflicts with an existing assignment' }],
    });
    expect(resultPost.status).toBe(MarketplacePostStatus.OPEN);
    expect(pubSub.publish).not.toHaveBeenCalled();
  });

  it('a stale post (shift assignment no longer resolves) is rejected and the post is expired, not left open', async () => {
    guardrailValidation.checkEligibility.mockResolvedValue({
      shiftAssignmentFound: false,
      eligible: false,
      violations: [],
    });

    const { claim, post: resultPost } = await service.claim(TENANT_ID, POST_ID, CLAIMANT_ID);

    expect(claim.status).toBe(MarketplaceClaimStatus.REJECTED);
    expect(claim.validationResult).toMatchObject({ eligible: false, reason: 'stale_post' });
    expect(resultPost.status).toBe(MarketplacePostStatus.EXPIRED);
    expect(pubSub.publish).toHaveBeenCalledTimes(1);
  });

  it('§4 steps 4/6: an eligible claim moves to pending_approval (no tenant auto-approval), the post flips to claimed, the subscription push fires, and Module 04 is not notified yet', async () => {
    const { claim, post: resultPost } = await service.claim(TENANT_ID, POST_ID, CLAIMANT_ID);

    expect(claim.status).toBe(MarketplaceClaimStatus.PENDING_APPROVAL);
    expect(claim.validationResult).toEqual({ eligible: true, violations: [] });
    expect(resultPost.status).toBe(MarketplacePostStatus.CLAIMED);
    expect(pubSub.publish).toHaveBeenCalledTimes(1);
    expect(redis.releaseClaimLock).toHaveBeenCalledWith(TENANT_ID, POST_ID, 'token-1');
    expect(eventPublisher.recordClaimApproved).not.toHaveBeenCalled();
    expect(engagement.recordEvent).not.toHaveBeenCalled();
  });

  it('§0.5/ADR-0089: with tenant auto-approval enabled, an eligible claim goes straight to approved and Module 04 is notified via ShiftClaimApproved', async () => {
    tenantPolicy.isAutoApprovalEnabled.mockReturnValue(true);

    const { claim } = await service.claim(TENANT_ID, POST_ID, CLAIMANT_ID);

    expect(claim.status).toBe(MarketplaceClaimStatus.APPROVED);
    // GAP-02: recorded into the transactional outbox from inside the same
    // manager/transaction as the claim approval, not published after it.
    expect(eventPublisher.recordClaimApproved).toHaveBeenCalledWith(manager, {
      tenantId: TENANT_ID,
      marketplaceClaimId: claim.id,
      marketplacePostId: POST_ID,
      shiftAssignmentId: 'shift-1',
      claimantEmployeeId: CLAIMANT_ID,
      approvedBy: null,
      source: MarketplaceClaimSource.OPEN_SHIFT_CLAIM,
    });
    expect(engagement.recordEvent).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      employeeId: CLAIMANT_ID,
      eventType: 'claim_approved',
      referenceId: claim.id,
    });
  });

  it('§5.2: a rate-limited caller is rejected before ever touching Redis or the database', async () => {
    rateLimiter.assertNotRateLimited.mockRejectedValue(new ClaimAttemptRateLimitExceededError(30));

    await expect(service.claim(TENANT_ID, POST_ID, CLAIMANT_ID)).rejects.toBeInstanceOf(
      ClaimAttemptRateLimitExceededError,
    );
    expect(redis.acquireClaimLock).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('§5.2: losing the lock counts as a failed attempt', async () => {
    redis.acquireClaimLock.mockResolvedValue(null);

    await expect(service.claim(TENANT_ID, POST_ID, CLAIMANT_ID)).rejects.toBeInstanceOf(PostAlreadyBeingClaimedError);
    expect(rateLimiter.recordFailedAttempt).toHaveBeenCalledWith(TENANT_ID, CLAIMANT_ID);
  });

  it('§5.2: a guardrail-rejected (ineligible) claim counts as a failed attempt', async () => {
    guardrailValidation.checkEligibility.mockResolvedValue({
      shiftAssignmentFound: true,
      eligible: false,
      violations: [{ category: 'min_rest', detail: 'conflicts with an existing assignment' }],
    });

    await service.claim(TENANT_ID, POST_ID, CLAIMANT_ID);

    expect(rateLimiter.recordFailedAttempt).toHaveBeenCalledWith(TENANT_ID, CLAIMANT_ID);
  });

  it('§5.2: a successful claim (pending_approval or approved) never counts as a failed attempt', async () => {
    await service.claim(TENANT_ID, POST_ID, CLAIMANT_ID);

    expect(rateLimiter.recordFailedAttempt).not.toHaveBeenCalled();
  });

  it('§5.2: an infra failure (Redis unavailable) never counts toward the rate limit', async () => {
    redis.acquireClaimLock.mockRejectedValue(
      new MarketplaceRedisUnavailableError('acquireClaimLock', new Error('ECONNREFUSED')),
    );

    await expect(service.claim(TENANT_ID, POST_ID, CLAIMANT_ID)).rejects.toBeInstanceOf(MarketplaceUnavailableError);
    expect(rateLimiter.recordFailedAttempt).not.toHaveBeenCalled();
  });
});
