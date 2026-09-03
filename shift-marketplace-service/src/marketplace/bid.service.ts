import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { withTenantConnection } from '../database/with-tenant-connection';
import { isUniqueViolation } from '../database/postgres-error-codes';
import { Bid } from './entities/bid.entity';
import { BidOpportunity, BidRankingMethod } from './entities/bid-opportunity.entity';
import { MarketplacePost, MarketplacePostStatus } from './entities/marketplace-post.entity';
import { MarketplaceClaim, MarketplaceClaimSource, MarketplaceClaimStatus } from './entities/marketplace-claim.entity';
import { GuardrailValidationService } from './guardrail-validation.service';
import { EmployeeGrpcClientService } from '../grpc/employee-grpc-client.service';
import { MarketplaceRedisService, MarketplaceRedisUnavailableError } from '../redis/redis.service';
import { CONTENTION_LOCK_TTL_SECONDS } from './contention-lock.constants';
import { computeRankings } from './bid-ranking';
import { BidOpportunityNotFoundError } from './errors/bid-opportunity-not-found.error';
import { BiddingWindowNotOpenError } from './errors/bidding-window-not-open.error';
import { BidderNotEligibleError } from './errors/bidder-not-eligible.error';
import { PreferenceScoreRequiredError } from './errors/preference-score-required.error';
import { AlreadyBidError } from './errors/already-bid.error';
import { BidOpportunityAlreadyClosedError } from './errors/bid-opportunity-already-closed.error';
import { TenantMarketplacePolicyService } from './tenant-marketplace-policy.service';
import { MarketplaceEventPublisherService } from './marketplace-event-publisher.service';
import { MarketplaceEngagementService } from './marketplace-engagement.service';
import { MarketplaceEngagementEventType } from './entities/marketplace-engagement-event.entity';
import { MetricsService } from '../common/metrics/metrics.service';
import { GRAPHQL_PUBSUB } from '../graphql/pubsub.provider';
import { marketplacePostUpdatedTrigger } from '../graphql/subscription-triggers';

export interface SubmitBidInput {
  tenantId: string;
  bidOpportunityId: string;
  employeeId: string;
  /** Required (and only meaningful) when the opportunity's `rankingMethod` is `preference_score`. */
  preferenceScore?: number;
}

/**
 * §8 Phase 4: `BidOpportunity`/`Bid`, reusing `GuardrailValidationService`
 * (§8's own instruction, same as `SwapRequestService`) for `submitBid`'s
 * eligibility gate, and §5.1's rank-transparency mechanism on close.
 */
@Injectable()
export class BidService {
  private readonly logger = new Logger(BidService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly guardrailValidation: GuardrailValidationService,
    private readonly employeeGrpcClient: EmployeeGrpcClientService,
    private readonly tenantPolicy: TenantMarketplacePolicyService,
    private readonly eventPublisher: MarketplaceEventPublisherService,
    private readonly engagement: MarketplaceEngagementService,
    private readonly metrics: MetricsService,
    private readonly redis: MarketplaceRedisService,
    @Inject(GRAPHQL_PUBSUB) private readonly pubSub: PubSub,
  ) {}

  async findById(tenantId: string, bidId: string): Promise<Bid | null> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(Bid, { where: { id: bidId, tenantId } }),
    );
  }

  /**
   * Shift Marketplace Manager View phase, §4 of the frontend prompt: the
   * bid-results transparency page's list endpoint - every bidder's
   * `rankPosition`/`rankExplanation`, not just the winner (§5.1's own
   * requirement). Same query shape `closeBidOpportunity` already runs
   * internally, just exposed as a public read method rather than only
   * ever used as an internal step.
   */
  async findAllByOpportunity(tenantId: string, bidOpportunityId: string): Promise<Bid[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager
        .createQueryBuilder(Bid, 'bid')
        .where('bid.tenantId = :tenantId', { tenantId })
        .andWhere('bid.bidOpportunityId = :bidOpportunityId', { bidOpportunityId })
        .orderBy('bid.rankPosition', 'ASC', 'NULLS LAST')
        .getMany(),
    );
  }

  async submitBid(input: SubmitBidInput): Promise<Bid> {
    const { tenantId, bidOpportunityId, employeeId } = input;

    const { opportunity, post } = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const opportunity = await manager.findOne(BidOpportunity, { where: { id: bidOpportunityId, tenantId } });
      if (!opportunity) {
        throw new BidOpportunityNotFoundError(bidOpportunityId);
      }
      const post = await manager.findOneOrFail(MarketplacePost, {
        where: { id: opportunity.marketplacePostId, tenantId },
      });
      return { opportunity, post };
    });

    const now = new Date();
    if (now < opportunity.biddingWindowStart) {
      throw new BiddingWindowNotOpenError(bidOpportunityId, 'not_yet_open');
    }
    if (now > opportunity.biddingWindowEnd) {
      throw new BiddingWindowNotOpenError(bidOpportunityId, 'closed');
    }

    if (opportunity.rankingMethod === BidRankingMethod.PREFERENCE_SCORE && input.preferenceScore === undefined) {
      throw new PreferenceScoreRequiredError(bidOpportunityId);
    }

    // §0's own non-negotiable, applied to bidding (§4/ADR-0086's same
    // guardrail path, never a parallel implementation): an ineligible
    // employee never gets a live bid at all.
    const eligibility = await this.guardrailValidation.checkEligibility({
      tenantId,
      candidateEmployeeId: employeeId,
      shiftAssignmentId: post.shiftAssignmentId,
      orgUnitId: post.orgUnitId,
    });
    if (!eligibility.shiftAssignmentFound || !eligibility.eligible) {
      throw new BidderNotEligibleError(bidOpportunityId);
    }

    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const bid = manager.create(Bid, {
        id: randomUUID(),
        tenantId,
        bidOpportunityId,
        employeeId,
        rankScore:
          opportunity.rankingMethod === BidRankingMethod.PREFERENCE_SCORE ? String(input.preferenceScore) : null,
        rankPosition: null,
        rankExplanation: null,
        submittedAt: new Date(),
      });
      try {
        await manager.save(bid);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AlreadyBidError(bidOpportunityId);
        }
        throw err;
      }
      return bid;
    });
  }

  /**
   * §5.1: computes `rankPosition`/`rankExplanation` (and, for
   * `preference_score`/`seniority`, `rankScore`) for every bid on this
   * opportunity - not just the winner. Idempotency guard: once any bid
   * already carries a non-null `rankPosition`, this opportunity has
   * already been closed (`rankPosition` is null-until-close by
   * construction, §2.1) - calling this again is a caller bug, not a
   * legitimate re-close.
   */
  async closeBidOpportunity(tenantId: string, bidOpportunityId: string): Promise<Bid[]> {
    const opportunity = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(BidOpportunity, { where: { id: bidOpportunityId, tenantId } }),
    );
    if (!opportunity) {
      throw new BidOpportunityNotFoundError(bidOpportunityId);
    }

    const bids = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.find(Bid, { where: { bidOpportunityId, tenantId } }),
    );
    if (bids.some((bid) => bid.rankPosition !== null)) {
      throw new BidOpportunityAlreadyClosedError(bidOpportunityId);
    }
    if (bids.length === 0) {
      return [];
    }

    let hireDateByEmployeeId: ReadonlyMap<string, string> | undefined;
    if (opportunity.rankingMethod === BidRankingMethod.SENIORITY) {
      const post = await withTenantConnection(this.dataSource, tenantId, (manager) =>
        manager.findOneOrFail(MarketplacePost, { where: { id: opportunity.marketplacePostId, tenantId } }),
      );
      const roster = await this.employeeGrpcClient.getSchedulableRoster(tenantId, post.orgUnitId);
      hireDateByEmployeeId = new Map(roster.map((employee) => [employee.employeeId, employee.hireDate]));
    }

    const ranked = computeRankings(
      opportunity.rankingMethod,
      bids.map((bid) => ({
        id: bid.id,
        employeeId: bid.employeeId,
        submittedAt: bid.submittedAt,
        rankScore: bid.rankScore,
      })),
      { asOf: new Date(), hireDateByEmployeeId },
    );
    const rankedById = new Map(ranked.map((r) => [r.id, r]));

    const saved = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const result: Bid[] = [];
      for (const bid of bids) {
        const ranked = rankedById.get(bid.id);
        if (!ranked) continue;
        bid.rankScore = ranked.rankScore;
        bid.rankPosition = ranked.rankPosition;
        bid.rankExplanation = ranked.rankExplanation;
        await manager.save(bid);
        result.push(bid);
      }
      return result;
    });

    const winner = saved.find((bid) => bid.rankPosition === 1);
    if (winner) {
      await this.convertWinningBidToClaim(tenantId, opportunity, winner);
    }

    return saved;
  }

  /**
   * ADR-0159: the handoff `MarketplaceEngagementService`'s own doc comment
   * flagged as missing - "a bid's winner is never turned into a real
   * assignment/NATS handoff." Mirrors `ClaimOpenShiftService.processClaim`'s
   * steps 1-2/4-7 in full, including the Redis contention lock
   * (`CONTENTION_LOCK_TTL_SECONDS`'s own doc comment: "shared by every
   * 'exactly one concurrent winner' race this module protects") - a
   * ranked bid opportunity's winner is exactly one more writer of
   * `MarketplacePost.status` that a concurrent `claimOpenShift` call on the
   * *same* post could otherwise race unprotected, since nothing about a
   * `BID`-type post's own `status` stops a plain first-come claim from
   * being attempted against it while (or after) bidding is still open.
   * Without this lock, `ClaimOpenShiftService.claim` and this method could
   * both read `status: open`, then both write a claim + flip the post,
   * producing two claims for one shift.
   *
   * Re-validates eligibility rather than trusting `submitBid`'s own
   * eligibility check - the bidding window can be hours or days long, so
   * conditions (the underlying `ShiftAssignment`, the bidder's own schedule)
   * may have changed since the bid was placed. A winner who fails
   * re-validation, or who loses the lock to a concurrent claim, is not
   * cascaded to the next-ranked bidder: §5.1 frames ranking as read-only
   * transparency, not an appeal/backfill workflow, and inventing a cascade
   * here would be a real behavior change beyond closing the missing
   * handoff. The opportunity still closes either way - every bidder still
   * gets their `rankPosition`/`rankExplanation` - just without a claim if
   * the winner turns out not to be convertible.
   */
  private async convertWinningBidToClaim(tenantId: string, opportunity: BidOpportunity, winner: Bid): Promise<void> {
    let lockToken: string | null;
    try {
      lockToken = await this.redis.acquireClaimLock(
        tenantId,
        opportunity.marketplacePostId,
        CONTENTION_LOCK_TTL_SECONDS,
      );
    } catch (err) {
      if (err instanceof MarketplaceRedisUnavailableError) {
        // §0.5's own fail-closed posture, extended here: no claim is
        // created rather than proceeding on an unlocked write.
        this.logger.error(
          `Redis unavailable while closing bid opportunity ${opportunity.id} - not converting winner ${winner.employeeId} to a claim: ${err.message}`,
        );
        return;
      }
      throw err;
    }
    if (lockToken === null) {
      // Lost the lock to a concurrent claim/swap attempt on the same post
      // (e.g. a live `claimOpenShift` call mid-flight right as this sweep
      // tick ran) - not converting now, same non-cascading posture as
      // every other "not converting" outcome below.
      this.logger.warn(
        `Bid opportunity ${opportunity.id} winner ${winner.employeeId} lost the contention lock on post ${opportunity.marketplacePostId} to a concurrent claim/swap - not converting to a claim.`,
      );
      return;
    }

    try {
      const post = await withTenantConnection(this.dataSource, tenantId, (manager) =>
        manager.findOne(MarketplacePost, { where: { id: opportunity.marketplacePostId, tenantId } }),
      );
      if (!post || post.status !== MarketplacePostStatus.OPEN) {
        this.logger.warn(
          `Bid opportunity ${opportunity.id} closed with a winner (${winner.employeeId}) but its post ${opportunity.marketplacePostId} is no longer open - not converting to a claim.`,
        );
        return;
      }

      let validation;
      try {
        validation = await this.guardrailValidation.checkEligibility({
          tenantId,
          candidateEmployeeId: winner.employeeId,
          shiftAssignmentId: post.shiftAssignmentId,
          orgUnitId: post.orgUnitId,
        });
      } catch (err) {
        // Same fail-closed posture as every other guardrail-gRPC chaos path
        // in this module: no claim is created rather than proceeding on
        // faith. Unlike `ClaimOpenShiftService`, there is no already-created
        // `pending_validation` row to mark rejected here - simply not
        // converting is itself the fail-closed outcome.
        this.logger.error(
          `Guardrail re-validation unavailable while closing bid opportunity ${opportunity.id} - not converting winner ${winner.employeeId} to a claim: ${(err as Error).message}`,
        );
        return;
      }

      if (!validation.shiftAssignmentFound || !validation.eligible) {
        this.logger.warn(
          `Bid opportunity ${opportunity.id} winner ${winner.employeeId} failed re-validation at close (shiftAssignmentFound=${validation.shiftAssignmentFound}, eligible=${validation.eligible}) - not converting to a claim.`,
        );
        return;
      }

      // GAP-01 (enterprise readiness audit, 2026-08-18): this INSERT shares
      // `uq_marketplace_claim_one_live_per_post` with `ClaimOpenShiftService.
      // processClaim`'s own claim insert - the same partial unique index
      // that closes this method's own doc comment's stated risk ("without
      // this lock, ClaimOpenShiftService.claim and this method could both
      // read status: open, then both write a claim + flip the post"), now
      // enforced at the database layer rather than by the Redis lock alone.
      // A conditional UPDATE on the post (guarded by `status = 'open'`)
      // additionally protects against the post having been flipped by
      // something that never touches `marketplace_claim` at all (the
      // expiry sweep), the same defense-in-depth `ClaimOpenShiftService`
      // now applies to its own final write.
      const autoApproved = this.tenantPolicy.isAutoApprovalEnabled(tenantId);
      const claim = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
        const claim = manager.create(MarketplaceClaim, {
          id: randomUUID(),
          tenantId,
          marketplacePostId: post.id,
          claimantEmployeeId: winner.employeeId,
          status: autoApproved ? MarketplaceClaimStatus.APPROVED : MarketplaceClaimStatus.PENDING_APPROVAL,
          source: MarketplaceClaimSource.BID,
          validationResult: { eligible: true, violations: [] },
          claimedAt: new Date(),
        });
        try {
          await manager.save(claim);
        } catch (err) {
          if (isUniqueViolation(err)) {
            return null;
          }
          throw err;
        }

        // TypeORM's `EntityManager.query()` returns `[rows, rowCount]` for
        // an UPDATE, even with RETURNING - not the rows array directly.
        // See `ClaimOpenShiftService.processClaim`'s identical fix for the
        // full explanation.
        const [claimedRows]: [Array<{ id: string }>, number] = await manager.query(
          `UPDATE marketplace.marketplace_post SET status = $1 WHERE id = $2 AND tenant_id = $3 AND status = $4 RETURNING id`,
          [MarketplacePostStatus.CLAIMED, post.id, tenantId, MarketplacePostStatus.OPEN],
        );
        if (claimedRows.length === 0) {
          // The claim row above is still live (pending_approval/approved) -
          // remove it rather than leaving an orphaned claim against a post
          // this method is not converting after all.
          await manager.delete(MarketplaceClaim, { id: claim.id });
          return null;
        }

        post.status = MarketplacePostStatus.CLAIMED;

        if (claim.status === MarketplaceClaimStatus.APPROVED) {
          // GAP-02: recorded into the transactional outbox *inside* this
          // same transaction as the claim/post writes above - see
          // `MarketplaceEventPublisherService`'s own doc comment.
          await this.eventPublisher.recordClaimApproved(manager, {
            tenantId,
            marketplaceClaimId: claim.id,
            marketplacePostId: post.id,
            shiftAssignmentId: post.shiftAssignmentId,
            claimantEmployeeId: claim.claimantEmployeeId,
            approvedBy: null,
            source: MarketplaceClaimSource.BID,
          });
        }

        return claim;
      });

      if (!claim) {
        this.logger.warn(
          `Bid opportunity ${opportunity.id} winner ${winner.employeeId} lost the database-level uniqueness race on post ${opportunity.marketplacePostId} to a concurrent claim/swap - not converting to a claim.`,
        );
        return;
      }

      const pushStart = process.hrtime.bigint();
      await this.pubSub.publish(marketplacePostUpdatedTrigger(tenantId, post.orgUnitId), {
        marketplacePostUpdated: post,
      });
      this.metrics.subscriptionPushDuration.observe(Number(process.hrtime.bigint() - pushStart) / 1e9);

      if (claim.status === MarketplaceClaimStatus.APPROVED) {
        await this.engagement.recordEvent({
          tenantId,
          employeeId: claim.claimantEmployeeId,
          eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
          referenceId: claim.id,
        });
      }
    } finally {
      await this.redis.releaseClaimLock(tenantId, opportunity.marketplacePostId, lockToken);
    }
  }
}
