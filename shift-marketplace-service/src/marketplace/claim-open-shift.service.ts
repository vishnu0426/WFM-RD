import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PubSub } from 'graphql-subscriptions';
import { withTenantConnection } from '../database/with-tenant-connection';
import { isUniqueViolation } from '../database/postgres-error-codes';
import { MarketplacePost, MarketplacePostStatus } from './entities/marketplace-post.entity';
import { MarketplaceClaim, MarketplaceClaimSource, MarketplaceClaimStatus } from './entities/marketplace-claim.entity';
import { MarketplaceRedisService, MarketplaceRedisUnavailableError } from '../redis/redis.service';
import { GuardrailValidationService } from './guardrail-validation.service';
import { MarketplacePostNotFoundError } from './errors/marketplace-post-not-found.error';
import { PostNotOpenError } from './errors/post-not-open.error';
import { PostAlreadyBeingClaimedError } from './errors/post-already-being-claimed.error';
import { MarketplaceUnavailableError } from './errors/marketplace-unavailable.error';
import { GRAPHQL_PUBSUB } from '../graphql/pubsub.provider';
import { marketplacePostUpdatedTrigger } from '../graphql/subscription-triggers';
import { MetricsService } from '../common/metrics/metrics.service';
import { CONTENTION_LOCK_TTL_SECONDS } from './contention-lock.constants';
import { TenantMarketplacePolicyService } from './tenant-marketplace-policy.service';
import { MarketplaceEventPublisherService } from './marketplace-event-publisher.service';
import { ClaimAttemptRateLimiterService } from './claim-attempt-rate-limiter.service';
import { MarketplaceEngagementService } from './marketplace-engagement.service';
import { MarketplaceEngagementEventType } from './entities/marketplace-engagement-event.entity';

export interface ClaimOpenShiftResult {
  claim: MarketplaceClaim;
  post: MarketplacePost;
}

/**
 * §4 in full, for the open-shift-claim case. This is the module's
 * signature mechanism - see this file's own step-by-step comments mapping
 * directly onto the module prompt's §4 numbered list.
 */
@Injectable()
export class ClaimOpenShiftService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: MarketplaceRedisService,
    private readonly guardrailValidation: GuardrailValidationService,
    private readonly metrics: MetricsService,
    private readonly tenantPolicy: TenantMarketplacePolicyService,
    private readonly eventPublisher: MarketplaceEventPublisherService,
    private readonly rateLimiter: ClaimAttemptRateLimiterService,
    private readonly engagement: MarketplaceEngagementService,
    @Inject(GRAPHQL_PUBSUB) private readonly pubSub: PubSub,
  ) {}

  async claim(tenantId: string, marketplacePostId: string, claimantEmployeeId: string): Promise<ClaimOpenShiftResult> {
    // §5.2: checked before any real work - a rate-limited caller never
    // touches Redis, never reaches Module 04's gRPC guardrail check. The
    // `rate_limited` label is this module's abuse signal, distinct from
    // every other outcome below (§5.2: "distinguish this in logging/metrics
    // from legitimate high-frequency use").
    try {
      await this.rateLimiter.assertNotRateLimited(tenantId, claimantEmployeeId);
    } catch (err) {
      this.metrics.claimAttemptsTotal.inc({ result: 'rate_limited' });
      throw err;
    }

    // §4 step 1: Redis distributed lock attempt, keyed on marketplace_post_id.
    const lockStart = process.hrtime.bigint();
    let lockToken: string | null;
    try {
      lockToken = await this.redis.acquireClaimLock(tenantId, marketplacePostId, CONTENTION_LOCK_TTL_SECONDS);
    } catch (err) {
      if (err instanceof MarketplaceRedisUnavailableError) {
        // §0.5's Redis chaos scenario: fail closed, never fall back to an
        // unlocked DB write. Infra failure, not a user-attributable
        // outcome - uncounted here (§5.2's limiter exists to catch abusive
        // *use*, not to penalize a caller for this platform's own hiccups).
        this.metrics.claimAttemptsTotal.inc({ result: 'infra_unavailable' });
        throw new MarketplaceUnavailableError();
      }
      throw err;
    } finally {
      this.metrics.claimLockAcquisitionDuration.observe(Number(process.hrtime.bigint() - lockStart) / 1e9);
    }

    if (lockToken === null) {
      // §4 step 3: the lock loser - immediate, distinct response, no
      // queuing on the winner's validation. Counts toward the rate limit
      // (§5.2: "failed/rejected claim attempts still count") since from the
      // caller's perspective this was a real, user-attributable attempt.
      await this.rateLimiter.recordFailedAttempt(tenantId, claimantEmployeeId);
      this.metrics.claimAttemptsTotal.inc({ result: 'lock_lost' });
      throw new PostAlreadyBeingClaimedError(marketplacePostId);
    }

    try {
      const result = await this.processClaim(tenantId, marketplacePostId, claimantEmployeeId);
      if (result.claim.status === MarketplaceClaimStatus.REJECTED) {
        await this.rateLimiter.recordFailedAttempt(tenantId, claimantEmployeeId);
        this.metrics.claimAttemptsTotal.inc({ result: 'rejected' });
      } else {
        this.metrics.claimAttemptsTotal.inc({ result: result.claim.status });
      }
      return result;
    } catch (err) {
      if (
        err instanceof MarketplacePostNotFoundError ||
        err instanceof PostNotOpenError ||
        err instanceof PostAlreadyBeingClaimedError
      ) {
        // User-attributable outcomes - a stale/expired post, a bad ID, or
        // (GAP-01) losing the DB-level uniqueness race after the Redis lock
        // itself was skipped/expired/lost to a partition - none of these
        // are an infra failure.
        await this.rateLimiter.recordFailedAttempt(tenantId, claimantEmployeeId);
        this.metrics.claimAttemptsTotal.inc({
          result:
            err instanceof MarketplacePostNotFoundError
              ? 'post_not_found'
              : err instanceof PostNotOpenError
                ? 'post_not_open'
                : 'lock_lost',
        });
      } else {
        // MarketplaceUnavailableError (Redis down) and any guardrail-gRPC
        // failure pass through uncounted for the rate limit, and are
        // labeled distinctly here too.
        this.metrics.claimAttemptsTotal.inc({ result: 'infra_unavailable' });
      }
      throw err;
    } finally {
      await this.redis.releaseClaimLock(tenantId, marketplacePostId, lockToken);
    }
  }

  private async processClaim(
    tenantId: string,
    marketplacePostId: string,
    claimantEmployeeId: string,
  ): Promise<ClaimOpenShiftResult> {
    // §4 step 2 (first half): pending_validation is committed as its own
    // step, in its own transaction, before the gRPC call - the lock (not an
    // open DB transaction) is what holds this claim exclusive while the
    // network round-trip to Module 04 happens.
    //
    // GAP-01 (enterprise readiness audit, 2026-08-18): the Redis lock above
    // is a fast-path optimization, not this method's only exclusivity
    // guarantee - `uq_marketplace_claim_one_live_per_post`
    // (`1700004000000-OneLiveClaimPerPost`) makes this INSERT itself the
    // real enforcement point. If the lock was skipped/expired/lost to a
    // Redis partition and a second caller reaches here concurrently, the
    // second INSERT fails on that unique index rather than silently
    // succeeding - caught below and surfaced as the same
    // `PostAlreadyBeingClaimedError` the lock-loser path already throws.
    const { post, claim } = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const post = await manager.findOne(MarketplacePost, { where: { id: marketplacePostId, tenantId } });
      if (!post) {
        throw new MarketplacePostNotFoundError(marketplacePostId);
      }
      if (post.status !== MarketplacePostStatus.OPEN) {
        throw new PostNotOpenError(marketplacePostId, post.status);
      }

      const claim = manager.create(MarketplaceClaim, {
        id: randomUUID(),
        tenantId,
        marketplacePostId,
        claimantEmployeeId,
        status: MarketplaceClaimStatus.PENDING_VALIDATION,
        source: MarketplaceClaimSource.OPEN_SHIFT_CLAIM,
        validationResult: null,
        claimedAt: new Date(),
      });
      try {
        await manager.save(claim);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new PostAlreadyBeingClaimedError(marketplacePostId);
        }
        throw err;
      }
      return { post, claim };
    });

    // §4 step 2 (second half): synchronous gRPC guardrail check - the same
    // call Module 04's own solver uses (ADR-0082), never a parallel
    // implementation.
    let validation;
    try {
      validation = await this.guardrailValidation.checkEligibility({
        tenantId,
        candidateEmployeeId: claimantEmployeeId,
        shiftAssignmentId: post.shiftAssignmentId,
        orgUnitId: post.orgUnitId,
      });
    } catch (err) {
      // §0.5's guardrail-gRPC chaos scenario: fail closed - the claim is
      // marked rejected (a transient reason, distinct from a real
      // ineligibility) rather than left stuck in `pending_validation`
      // forever, which would otherwise be exactly the "invalid claim
      // occupying a slot" bug §2.2 rule 2 warns against, just one status
      // earlier than the one that rule names. The post itself was never
      // touched, so it's still `open` - no revert needed. The caller still
      // sees the real error (rethrown after this best-effort write), never
      // a silent "proceeded anyway."
      await withTenantConnection(this.dataSource, tenantId, async (manager) => {
        const failedClaim = await manager.findOneOrFail(MarketplaceClaim, { where: { id: claim.id, tenantId } });
        failedClaim.status = MarketplaceClaimStatus.REJECTED;
        failedClaim.validationResult = { eligible: false, reason: 'guardrail_validation_unavailable' };
        await manager.save(failedClaim);
      });
      throw err;
    }

    const { finalPost, finalClaim } = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const finalClaim = await manager.findOneOrFail(MarketplaceClaim, { where: { id: claim.id, tenantId } });
      const finalPost = await manager.findOneOrFail(MarketplacePost, { where: { id: marketplacePostId, tenantId } });

      if (!validation.shiftAssignmentFound) {
        // The underlying ShiftAssignment no longer resolves (already
        // claimed/changed directly in Module 04 since this post was
        // created) - a stale post, not a normal ineligibility. §4 step 5's
        // "the post becomes claimable again immediately" doesn't apply
        // here since there's nothing valid left to claim.
        finalClaim.status = MarketplaceClaimStatus.REJECTED;
        finalClaim.validationResult = { eligible: false, reason: 'stale_post', violations: [] };
        finalPost.status = MarketplacePostStatus.EXPIRED;
        await manager.save(finalClaim);
        await manager.save(finalPost);
        return { finalPost, finalClaim };
      }

      if (!validation.eligible) {
        // §4 step 5: rejected with the structured reason, post reverts to
        // (stays) open - claimable again immediately, not stuck in limbo.
        finalClaim.status = MarketplaceClaimStatus.REJECTED;
        finalClaim.validationResult = { eligible: false, violations: validation.violations };
        await manager.save(finalClaim);
        return { finalPost, finalClaim };
      }

      // §4 step 4: validation pass - post flips to claimed either way.
      // Auto-approval (§0.5's progressive-delivery row, ADR-0089) skips
      // straight to `approved`; otherwise this stays `pending_approval`
      // until a supervisor calls `approveMarketplaceAction`.
      //
      // GAP-01: `uq_marketplace_claim_one_live_per_post` already rules out
      // a second live *claim* on this post (caught at INSERT time, above).
      // The one race that constraint alone can't catch is this post being
      // flipped out of `open` by something that never creates a
      // `marketplace_claim` row at all - the expiry sweep
      // (`idx_marketplace_post_tenant_status_expires_at`'s own comment:
      // "an expired-but-still-open post is this module's own sweep
      // target") racing the exact window between this validation pass and
      // the write below. A conditional UPDATE closes that: if the post is
      // no longer `open` by the time this runs, this claim loses to
      // whatever already changed it, rather than blindly overwriting that
      // outcome back to `claimed`.
      const autoApproved = this.tenantPolicy.isAutoApprovalEnabled(tenantId);
      // TypeORM's `EntityManager.query()` returns `[rows, rowCount]` for an
      // UPDATE - even one with RETURNING - not the rows array directly;
      // only a plain SELECT gets that shortcut
      // (`node_modules/typeorm/driver/postgres/PostgresQueryRunner.js`'s
      // `query()`: `case 'UPDATE': result.raw = [raw.rows, raw.rowCount]`
      // vs `default: result.raw = raw.rows`). Destructuring the tuple here
      // is required - the un-destructured version always had `.length`
      // 2 regardless of whether the UPDATE matched a row, so the "lost the
      // race" branch below could never actually trigger. Caught via a real
      // Postgres integration test on an identical pattern in the root
      // platform-core service, not by this file's own mocked unit tests.
      const [claimedRows]: [Array<{ id: string }>, number] = await manager.query(
        `UPDATE marketplace.marketplace_post SET status = $1 WHERE id = $2 AND tenant_id = $3 AND status = $4 RETURNING id`,
        [MarketplacePostStatus.CLAIMED, marketplacePostId, tenantId, MarketplacePostStatus.OPEN],
      );

      if (claimedRows.length === 0) {
        finalClaim.status = MarketplaceClaimStatus.REJECTED;
        finalClaim.validationResult = { eligible: false, reason: 'post_no_longer_open', violations: [] };
        await manager.save(finalClaim);
        const currentPost = await manager.findOneOrFail(MarketplacePost, {
          where: { id: marketplacePostId, tenantId },
        });
        return { finalPost: currentPost, finalClaim };
      }

      finalClaim.status = autoApproved ? MarketplaceClaimStatus.APPROVED : MarketplaceClaimStatus.PENDING_APPROVAL;
      finalClaim.validationResult = { eligible: true, violations: [] };
      finalPost.status = MarketplacePostStatus.CLAIMED;
      await manager.save(finalClaim);

      if (finalClaim.status === MarketplaceClaimStatus.APPROVED) {
        // §4 step 7: the actual Module 04 handoff - never fired for a claim
        // still sitting in `pending_approval`.
        //
        // GAP-02: recorded into the transactional outbox *inside* this
        // same transaction (same manager) as the claim/post writes above,
        // not published to NATS after the fact - see
        // `MarketplaceEventPublisherService`'s own doc comment.
        await this.eventPublisher.recordClaimApproved(manager, {
          tenantId,
          marketplaceClaimId: finalClaim.id,
          marketplacePostId: finalPost.id,
          shiftAssignmentId: finalPost.shiftAssignmentId,
          claimantEmployeeId: finalClaim.claimantEmployeeId,
          approvedBy: null,
          source: MarketplaceClaimSource.OPEN_SHIFT_CLAIM,
        });
      }

      return { finalPost, finalClaim };
    });

    if (finalPost.status !== MarketplacePostStatus.OPEN) {
      // §4 step 6: push the status change the moment it changes - this is
      // what makes the post disappear live for everyone else. Skipped when
      // the post never actually changed (a rejected claim leaves it open).
      await this.publishPostUpdated(tenantId, finalPost);
    }

    if (finalClaim.status === MarketplaceClaimStatus.APPROVED) {
      // Phase 7 (ADR-0091): the same "approved" moment that triggers
      // Module 04's handoff also earns engagement points - this branch is
      // the auto-approval counterpart to `ApproveMarketplaceActionService.
      // approveClaim`'s own identical call, never double-fired for the
      // same claim since a claim reaches `approved` through exactly one of
      // these two paths.
      await this.engagement.recordEvent({
        tenantId,
        employeeId: finalClaim.claimantEmployeeId,
        eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
        referenceId: finalClaim.id,
      });
    }

    return { claim: finalClaim, post: finalPost };
  }

  private async publishPostUpdated(tenantId: string, post: MarketplacePost): Promise<void> {
    const pushStart = process.hrtime.bigint();
    await this.pubSub.publish(marketplacePostUpdatedTrigger(tenantId, post.orgUnitId), {
      marketplacePostUpdated: post,
    });
    this.metrics.subscriptionPushDuration.observe(Number(process.hrtime.bigint() - pushStart) / 1e9);
  }
}
