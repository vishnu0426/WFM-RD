import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { MarketplaceClaim, MarketplaceClaimStatus } from './entities/marketplace-claim.entity';
import { MarketplacePost } from './entities/marketplace-post.entity';
import { SwapRequest, SwapRequestStatus } from './entities/swap-request.entity';
import { MarketplaceEventPublisherService } from './marketplace-event-publisher.service';
import { MarketplaceEngagementService } from './marketplace-engagement.service';
import { MarketplaceEngagementEventType } from './entities/marketplace-engagement-event.entity';
import { MarketplaceClaimNotFoundError } from './errors/marketplace-claim-not-found.error';
import { SwapRequestNotFoundError } from './errors/swap-request-not-found.error';
import { ActionNotPendingApprovalError } from './errors/action-not-pending-approval.error';

export type ApprovedMarketplaceAction =
  { kind: 'claim'; claim: MarketplaceClaim } | { kind: 'swap'; swap: SwapRequest };

/**
 * §3.1's `approveMarketplaceAction` - the supervisor-approval path for
 * whichever `MarketplaceClaim`/`SwapRequest` a tenant's auto-approval
 * policy didn't already clear (`TenantMarketplacePolicyService`,
 * ADR-0089's own auto-approval branch inside `ClaimOpenShiftService`/
 * `SwapRequestService` themselves). This service is the *only* other path
 * to `approved`/`accepted` - there is no code path that reaches Module
 * 04's NATS handoff without going through either this service or that
 * auto-approval branch.
 *
 * No approver-role check (`requireActorId()`'s bound actor is trusted as
 * a supervisor without verification) - same placeholder-auth posture
 * every mutation in this service already has (ADR-0084); a real RBAC gate
 * belongs to whichever future phase adds real identity verification
 * platform-wide, not invented here as a one-off.
 */
@Injectable()
export class ApproveMarketplaceActionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventPublisher: MarketplaceEventPublisherService,
    private readonly engagement: MarketplaceEngagementService,
  ) {}

  async approveClaim(tenantId: string, claimId: string, approverId: string): Promise<MarketplaceClaim> {
    const claim = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const claim = await manager.findOne(MarketplaceClaim, { where: { id: claimId, tenantId } });
      if (!claim) {
        throw new MarketplaceClaimNotFoundError(claimId);
      }
      if (claim.status !== MarketplaceClaimStatus.PENDING_APPROVAL) {
        throw new ActionNotPendingApprovalError(claimId, claim.status);
      }
      claim.status = MarketplaceClaimStatus.APPROVED;
      await manager.save(claim);
      const post = await manager.findOneOrFail(MarketplacePost, { where: { id: claim.marketplacePostId, tenantId } });

      // GAP-02 (enterprise readiness audit, 2026-08-18): recorded into the
      // transactional outbox *inside* this same transaction as the claim
      // approval above - see `MarketplaceEventPublisherService`'s own doc
      // comment.
      await this.eventPublisher.recordClaimApproved(manager, {
        tenantId,
        marketplaceClaimId: claim.id,
        marketplacePostId: post.id,
        shiftAssignmentId: post.shiftAssignmentId,
        claimantEmployeeId: claim.claimantEmployeeId,
        approvedBy: approverId,
        // ADR-0159: a claim created by `BidService.closeBidOpportunity` can
        // reach this supervisor-approval path just as easily as one created
        // by `ClaimOpenShiftService` - `claim.source` (persisted at creation,
        // not inferred here) is what tells scheduling-service which one it was.
        source: claim.source,
      });

      return claim;
    });

    // Phase 7 (ADR-0091): the supervisor-approval counterpart to
    // `ClaimOpenShiftService`'s own auto-approval engagement call - the
    // two never overlap for the same claim.
    await this.engagement.recordEvent({
      tenantId,
      employeeId: claim.claimantEmployeeId,
      eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
      referenceId: claim.id,
    });
    return claim;
  }

  async approveSwap(tenantId: string, swapRequestId: string, approverId: string): Promise<SwapRequest> {
    const swap = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const swap = await manager.findOne(SwapRequest, { where: { id: swapRequestId, tenantId } });
      if (!swap) {
        throw new SwapRequestNotFoundError(swapRequestId);
      }
      if (swap.status !== SwapRequestStatus.PENDING_APPROVAL) {
        throw new ActionNotPendingApprovalError(swapRequestId, swap.status);
      }
      swap.status = SwapRequestStatus.ACCEPTED;
      await manager.save(swap);

      // GAP-02 (enterprise readiness audit, 2026-08-18): recorded into the
      // transactional outbox *inside* this same transaction as the
      // acceptance above - see `MarketplaceEventPublisherService`'s own
      // doc comment.
      await this.eventPublisher.recordSwapExecuted(manager, {
        tenantId,
        swapRequestId: swap.id,
        initiatorEmployeeId: swap.initiatorEmployeeId,
        initiatorShiftId: swap.initiatorShiftId,
        targetEmployeeId: swap.targetEmployeeId as string,
        targetShiftId: swap.targetShiftId as string,
        approvedBy: approverId,
      });

      return swap;
    });

    // Phase 7 (ADR-0091): both participants earn engagement points for an
    // executed swap - each side gave up and picked up a shift, same as
    // `SwapRequestService`'s own auto-approval counterpart.
    await Promise.all([
      this.engagement.recordEvent({
        tenantId,
        employeeId: swap.initiatorEmployeeId,
        eventType: MarketplaceEngagementEventType.SWAP_EXECUTED,
        referenceId: swap.id,
      }),
      this.engagement.recordEvent({
        tenantId,
        employeeId: swap.targetEmployeeId as string,
        eventType: MarketplaceEngagementEventType.SWAP_EXECUTED,
        referenceId: swap.id,
      }),
    ]);
    return swap;
  }

  /**
   * Shift Marketplace Manager View phase, §2: the approval queue's twin
   * action to `approveClaim` - equally easy, equally visible (§0.5's own
   * "no UI nudge toward approval"). Unlike approval, a rejection has no
   * downstream NATS/engagement side effects to fire - nothing was granted,
   * so there is nothing for scheduling-service or the engagement ledger to
   * react to. `reason` is required at the GraphQL argument level
   * (`rejectMarketplaceAction`'s own `reason: String!`), persisted so the
   * employee side of this platform has something real to show.
   */
  async rejectClaim(tenantId: string, claimId: string, reason: string): Promise<MarketplaceClaim> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const claim = await manager.findOne(MarketplaceClaim, { where: { id: claimId, tenantId } });
      if (!claim) {
        throw new MarketplaceClaimNotFoundError(claimId);
      }
      if (claim.status !== MarketplaceClaimStatus.PENDING_APPROVAL) {
        throw new ActionNotPendingApprovalError(claimId, claim.status);
      }
      claim.status = MarketplaceClaimStatus.REJECTED;
      claim.decisionReason = reason;
      await manager.save(claim);
      return claim;
    });
  }

  async rejectSwap(tenantId: string, swapRequestId: string, reason: string): Promise<SwapRequest> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const swap = await manager.findOne(SwapRequest, { where: { id: swapRequestId, tenantId } });
      if (!swap) {
        throw new SwapRequestNotFoundError(swapRequestId);
      }
      if (swap.status !== SwapRequestStatus.PENDING_APPROVAL) {
        throw new ActionNotPendingApprovalError(swapRequestId, swap.status);
      }
      swap.status = SwapRequestStatus.REJECTED;
      swap.decisionReason = reason;
      await manager.save(swap);
      return swap;
    });
  }
}
