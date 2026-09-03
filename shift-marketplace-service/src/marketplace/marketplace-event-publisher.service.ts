import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { MARKETPLACE_SUBJECTS } from '../nats/subjects';
import { MarketplaceOutboxEventsRepository } from './repositories/marketplace-outbox-events.repository';

export interface ClaimApprovedEvent {
  tenantId: string;
  marketplaceClaimId: string;
  marketplacePostId: string;
  shiftAssignmentId: string;
  claimantEmployeeId: string;
  /** `null` = auto-approved (tenant policy), never a human. */
  approvedBy: string | null;
  /**
   * ADR-0159: which mechanism produced the claim
   * (`MarketplaceClaim.source`) - scheduling-service's NATS consumer uses
   * this to pick `assignment_source: 'claim'` vs. `'bid'` on the resulting
   * `ShiftAssignment` (the `bid` value has existed in that column's CHECK
   * constraint since Module 04's first migration, unused until now).
   */
  source: 'open_shift_claim' | 'bid';
}

export interface SwapExecutedEvent {
  tenantId: string;
  swapRequestId: string;
  initiatorEmployeeId: string;
  initiatorShiftId: string;
  targetEmployeeId: string;
  targetShiftId: string;
  /** `null` = auto-approved (tenant policy), never a human. */
  approvedBy: string | null;
}

/**
 * §4 step 7: the single place `ShiftClaimApproved`/`SwapExecuted` actually
 * get built - shared by `ClaimOpenShiftService`/`SwapRequestService`'s own
 * auto-approval paths, `BidService.convertWinningBidToClaim`, and
 * `ApproveMarketplaceActionService`'s supervisor-approval path, so the
 * payload shape can never drift between "approved automatically" and
 * "approved by a human."
 *
 * GAP-02 fix (enterprise readiness audit, 2026-08-18): this used to publish
 * to NATS directly, best-effort, *after* the caller's own transaction had
 * already committed - a NATS outage at that exact instant lost the event
 * permanently, with no retry and no way for scheduling-service to discover
 * the approval any other way. Both methods now take the caller's own
 * `EntityManager` and write to `marketplace.marketplace_outbox_event`
 * *inside* that same transaction instead - the actual NATS publish is
 * `MarketplaceOutboxPublisherService`'s job, on its own independent,
 * retrying schedule. Every caller of this service must call it from inside
 * its own `withTenantConnection` block now, not after it.
 */
@Injectable()
export class MarketplaceEventPublisherService {
  async recordClaimApproved(manager: EntityManager, event: ClaimApprovedEvent): Promise<void> {
    const payload = { ...event, approvedAt: new Date().toISOString() };
    await MarketplaceOutboxEventsRepository.insertWithinTransaction(
      manager,
      event.tenantId,
      MARKETPLACE_SUBJECTS.CLAIM_APPROVED,
      payload,
    );
  }

  async recordSwapExecuted(manager: EntityManager, event: SwapExecutedEvent): Promise<void> {
    const payload = { ...event, executedAt: new Date().toISOString() };
    await MarketplaceOutboxEventsRepository.insertWithinTransaction(
      manager,
      event.tenantId,
      MARKETPLACE_SUBJECTS.SWAP_EXECUTED,
      payload,
    );
  }
}
