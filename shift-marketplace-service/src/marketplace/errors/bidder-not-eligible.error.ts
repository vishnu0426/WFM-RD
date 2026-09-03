import { DomainError } from '../../common/errors/domain-error';

/**
 * §0's own non-negotiable, applied to bidding: an ineligible employee
 * never gets a live bid in the first place - the same "structurally
 * cannot be assigned, not merely discouraged" posture Module 04's own
 * `_is_eligible` gating uses for the solver, applied here at submission
 * time rather than only at eventual assignment time. Catching this at
 * `submitBid` (not just later, when a winning bid would be committed)
 * avoids ever ranking a bid that could never actually be honored.
 */
export class BidderNotEligibleError extends DomainError {
  constructor(bidOpportunityId: string) {
    super('BIDDER_NOT_ELIGIBLE', `You are not eligible for the shift behind bid opportunity ${bidOpportunityId}.`);
  }
}
