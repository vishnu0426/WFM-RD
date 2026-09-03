# ADR-0159: `BidService.closeBidOpportunity` converts the ranked winner into a real `MarketplaceClaim`, closing the bid-to-assignment gap ADR-0089 explicitly left open

## Context

ADR-0089 closed the open-shift-claim and swap-request paths end to end -
an approved claim/swap becomes a real, locked `ShiftAssignment` in Module
04 - and named its own remaining scope gap explicitly: "Bid-to-assignment
commit is explicitly **not** built this phase... A bid winner becoming a
real locked assignment is unscoped work, not silently implied by this
ADR." `BidService.closeBidOpportunity` (§5.1, Phase 4) has, ever since,
only computed `rankPosition`/`rankExplanation`/`rankScore` for every
bidder - real, useful rank transparency, but a dead end: nothing flips the
originating `MarketplacePost` to `claimed`, nothing notifies Module 04,
and nothing awards `MarketplaceEngagementService` points. The service's
own doc comment said as much: "a bid's winner is never turned into a real
assignment/NATS handoff yet... flagged here and in ADR-0091 for whichever
future phase closes bidding's own missing handoff."

ADR-0092 (Phase 8) reconfirmed this gap deliberately rather than closing
it - "essentially a Phase 4.5 feature addition, not a Phase 8
documentation/load-test task... named prominently in the runbook and the
Phase 8 checklist's 'Module-wide standing gaps' section as this module's
single most consequential open item, for a human to decide whether and
when to commission the follow-up work." This ADR is that follow-up work,
commissioned now.

It also closes a smaller, related gap:
`scheduling.shift_assignments.assignment_source`'s CHECK constraint has
allowed a `'bid'` value since Module 04's very first migration (0001) -
`swap`/`bid` were reserved up front, one per marketplace mechanism - but
`bid` has never once been written, because nothing ever produced a
`ShiftClaimApproved` event for a bid win until now.

## Decision

**`closeBidOpportunity` finds the rank-1 winner after ranking is saved,
then attempts to convert it into a `MarketplaceClaim`** via a new private
`convertWinningBidToClaim`, mirroring `ClaimOpenShiftService.processClaim`'s
own steps 1-2 and 4-7 in full - including the Redis contention lock. A
first draft of this method omitted the lock, reasoning "there is exactly
one winner by the time ranking has run, so there is no concurrent-claimant
race to arbitrate." That reasoning missed a real race: nothing about a
`BID`-type `MarketplacePost`'s own `status` stops a plain first-come
`claimOpenShift` call from being attempted against the *same* post while
(or after) its bidding window is open - `submitBid` never checks
`post.status` either. Without the lock, `ClaimOpenShiftService.claim` and
this method could both read `status: open`, then both write a claim and
flip the post, producing two claims for one shift. Caught in review before
this ADR shipped, not after - `CONTENTION_LOCK_TTL_SECONDS`'s own doc
comment already named the pattern this should have followed from the
start ("shared by every 'exactly one concurrent winner' race this module
protects"). A winner who loses the lock to a concurrent claim/swap is
treated the same as a winner who fails re-validation below - not
converted, not cascaded, logged.

**Eligibility is re-checked, not trusted from `submitBid` time.** A
bidding window can be hours or days long; the underlying `ShiftAssignment`
or the bidder's own schedule may have changed since they placed their bid.
A winner who fails re-validation, or whose post is no longer `open`, is
**not** cascaded to the next-ranked bidder - §5.1 frames ranking as
read-only transparency, not an appeal/backfill workflow, and a cascade
would be a real behavior change beyond closing the missing handoff. The
opportunity still closes either way: every bidder still gets their
`rankPosition`/`rankExplanation`, just without a resulting claim if the
winner turns out not to be convertible. This is logged, not silent.

**`MarketplaceClaim` gains a `source` column** (`open_shift_claim` |
`bid`, migration `1700003000000-MarketplaceClaimSource`, default
`open_shift_claim` for every pre-existing row). This has to be a real,
persisted column rather than something inferred at approval time: a claim
created by `convertWinningBidToClaim` with no tenant auto-approval sits at
`pending_approval` until a supervisor calls `approveMarketplaceAction`,
possibly long after the bid closed - `ApproveMarketplaceActionService.
approveClaim` has no other way to know which mechanism produced the claim
it's approving.

**`ClaimApprovedEvent` gains a `source: 'open_shift_claim' | 'bid'`
field**, populated from `MarketplaceClaim.source` at every call site
(`ClaimOpenShiftService`'s auto-approval branch, `ApproveMarketplaceActionService.
approveClaim`, and the new bid-conversion path). scheduling-service's NATS
consumer (`_apply_claim_approved`) reads it, defaulting to
`open_shift_claim` for any payload published before this ADR so existing
in-flight/replayed messages keep behaving exactly as they did -
`apply_marketplace_claim` now takes a `source` parameter and sets
`assignment_source`/`publish_assignment_changed`'s `reason` to `bid` or
`claim` accordingly. `AssignmentChangeReason` (Module 05's own consumed
field) gains the `bid` literal too.

**No cascading fallback, no approver-role check, no new engagement event
type** - `CLAIM_APPROVED` already fits ("a claim I created got approved"
is the complete signal regardless of which mechanism created the claim);
inventing more here would be solving problems this phase wasn't asked to
solve.

## Consequences

- Verified with a real-Postgres integration test extension
  (`test/integration/bid-close.spec.ts`): closing a three-bidder
  first-come opportunity against real Postgres now leaves a real
  `MarketplaceClaim` row (`source: bid`, `status: pending_approval`) and a
  real `claimed` `MarketplacePost`, not just ranked bids. A new
  scheduling-service integration test
  (`test_shift_claim_approved_with_bid_source_locks_the_assignment_as_bid`)
  proves the full cross-service loop: a `source: "bid"` event lands as
  `assignment_source: "bid"`, `locked: true`.
- `bid.service.spec.ts` gained four lock-specific tests: the lock is
  acquired on the post before it's read and released afterward in every
  outcome (success, guardrail rejection, guardrail-gRPC unavailable), a
  lost lock skips conversion without touching the post, and a Redis
  outage skips conversion without ever reaching the guardrail check -
  same shape as `ClaimOpenShiftService`'s own existing chaos-path tests.
- `BidCloseSweepService` is now on the only path that turns a bid into a
  real assignment, not just a transparency computation - its own tick had
  no metric before this ADR (`marketplace_bid_close_sweep_ticks_total`/
  `..._opportunities_total`, added alongside this change) precisely
  because a silently wedged sweep was lower-stakes before now.
- This module's own long-standing single-instance-sweep limitation
  (multiple `BidCloseSweepService` instances racing on the same
  `bidding_window_end < now()` candidate query) is unchanged by this ADR -
  it already existed for the ranking write alone, and converting the
  winner inherits it rather than introducing it. Still worth closing in
  whichever future phase gives this service more than one replica.
