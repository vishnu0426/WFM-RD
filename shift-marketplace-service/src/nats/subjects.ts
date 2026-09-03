/**
 * §4 step 7: `ShiftClaimApproved`/`SwapExecuted` - scheduling-service's
 * NATS consumer (ADR-0089) is this stream's only subscriber. Same
 * `agno.<domain>.<entity>.<event>.v<version>` grammar as every other
 * subject in this platform.
 */
export const MARKETPLACE_SUBJECTS = {
  CLAIM_APPROVED: 'agno.marketplace.claim.approved.v1',
  SWAP_EXECUTED: 'agno.marketplace.swap.executed.v1',
} as const;
