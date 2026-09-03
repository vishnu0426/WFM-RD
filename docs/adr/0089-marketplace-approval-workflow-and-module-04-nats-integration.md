# ADR-0089: tenant auto-approval policy, `approveMarketplaceAction`, and scheduling-service's first NATS consumer close the loop to a real, locked `ShiftAssignment`

## Context
§4 step 7 and §0.5's progressive-delivery row are this module's actual
purpose, restated: an approved claim/swap must become a real, locked
`ShiftAssignment` row in Module 04 - "this module's whole purpose depends
on that downstream rule actually being enforced; verify it in integration
testing, don't just assume it." Phases 2-4 deliberately stopped short of
this (claims/swaps landed in `pending_approval`, never `approved`/
`accepted`, and no NATS publish ever fired) - this phase closes that gap
end to end, and turned up two more real gaps along the way, both closed
here rather than deferred:

1. **`scheduling.shift_assignments.assignment_source`'s existing enum
   (`auto_generated`/`manual_override`/`swap`/`bid`) has no value for a
   plain open-shift claim.** `swap`/`bid` are already spoken for by their
   own marketplace mechanisms; reusing either for a claim would
   misrepresent *how* the assignment came to be, defeating the column's
   own purpose (ADR-0058's "restore the real `assignment_source`... not
   silently un-mark a decision," one value short).
2. **scheduling-service has no NATS consumer at all** - every prior NATS
   presence there (`app/events/nats_publisher.py`) is publish-only. Making
   Module 07's claims/swaps real requires scheduling-service's *first*
   subscriber.

## Decision

**`assignment_source` gains a `claim` value** (migration `0005`, dynamically
finds and replaces the existing inline/unnamed CHECK constraint with an
explicitly-named one rather than guessing Postgres's auto-generated name).
`locked` (`GENERATED ALWAYS AS (assignment_source <> 'auto_generated')`)
covers it automatically - no separate change needed.

**Auto-vs-supervisor approval is a flat, tenant-id-list env var**
(`TenantMarketplacePolicyService`, `MARKETPLACE_AUTO_APPROVAL_TENANT_IDS`) -
same explicit, un-designed placeholder posture Module 05/06 used for their
own Phase-1 per-tenant settings (`INTRADAY_WEBHOOK_SECRETS`/
`ATTENDANCE_WEBHOOK_SECRETS`), since no tenant-settings service exists
anywhere in this platform to hook a real flag into. Defaults to empty -
every tenant requires supervisor approval unless explicitly listed,
matching §0.5's own instruction literally. `SwapRequest.
requiresSupervisorApproval` (already a per-row column since Phase 3) is
also consulted (`autoApproved = tenantAutoApproval || !requiresSupervisorApproval`),
wired now even though nothing in the current `proposeSwap` API surface can
set it to `false` yet - ready for whichever future mutation input adds
that without touching this decision point again.

**`SwapRequestStatus` gains `pending_approval`** - the swap-side
counterpart to `MarketplaceClaimStatus.PENDING_APPROVAL` (§2.2 rule 2's
own pattern, extended to the point after both sides validate but before
either auto-approval or a supervisor commits the trade). `accepted` now
means "approved, going to `SwapExecuted`," not "both sides agreed" - the
same distinction `MarketplaceClaimStatus.APPROVED` already drew relative
to `PENDING_APPROVAL`.

**`approveMarketplaceAction(claimId, swapRequestId)`** - exactly one must
be provided (`ApproveMarketplaceActionInputInvalidError` otherwise), since
claims and swaps are different entities with different approval targets
and this mutation needs to know which. Returns a plain object with
`claim`/`swap` fields (exactly one populated) rather than a GraphQL union -
simpler for clients, and this mutation only ever approves one of two known
entity types, not an open-ended set. No approver-role check - the bound
actor is trusted as a supervisor without verification, the same
placeholder-auth posture every mutation in this service already has
(ADR-0084); real RBAC belongs to a future platform-wide identity phase.

**`MarketplaceEventPublisherService`** is the single place `ShiftClaimApproved`/
`SwapExecuted` get built, shared by the auto-approval branches inside
`ClaimOpenShiftService`/`SwapRequestService` and
`ApproveMarketplaceActionService`'s supervisor path - the payload shape
can never drift between "approved automatically" and "approved by a
human." Best-effort/non-transactional with the Postgres approval, same
posture attendance-leave-service's own `DecideLeaveRequestService` NATS
publish takes (ADR-0078) - a failed publish is a monitored propagation
gap, not a reason to fail an approval that already committed.

**scheduling-service's new NATS consumer** (`app/nats/marketplace_consumer.py`)
is a durable pull consumer bound to shift-marketplace-service's own
`AGNO_MARKETPLACE_EVENTS` stream (provisioned via `scripts/provision-nats-
streams.ts`, the same Node-side convention every other stream in this
platform uses - scheduling-service is a cross-language, cross-repo
*consumer* of a stream it doesn't own or provision, exactly how NATS
JetStream's own decoupled pub/sub model is meant to work). Hosted as a
background `asyncio` task in the same process as the FastAPI app and the
Module 04 gRPC server (ADR-0082) - event-driven, not CPU-bound, no reason
to live in `app/worker.py`'s separate process. `ack()` on success, `nak()`
on a transient failure (redelivery), `term()` **plus a best-effort publish
to `AGNO_MARKETPLACE_DLQ`** on a permanent failure (`DomainError` - e.g.
the referenced `ShiftAssignment` doesn't exist - or a malformed payload,
`KeyError`/`ValueError`) - redelivering a poison message forever would
never fix it, and silently dropping it without a DLQ trace would be its
own trust-eroding bug.

**`ClaimApprovedEvent`/`SwapExecutedEvent` are applied via new
`schedule_service.apply_marketplace_claim`/`apply_marketplace_swap`
functions**, siblings of `override_assignment` (a shared
`_record_double_booking_if_any` helper factored out once there were three
call sites, not two): looked up by `(tenant_id, id)` alone, not
`(tenant_id, schedule_id, id)`, since a marketplace event carries no
`schedule_id` (Module 07 never stores one). Both bypass the same
eligibility re-check `override_assignment` bypasses, for the same reason:
Module 07 already ran the real guardrail check
(`SchedulingEligibilityService.CheckAssignmentEligibility`, ADR-0082)
before ever approving - re-validating here would itself be the "parallel
implementation" this platform's non-negotiable forbids. `apply_marketplace_swap`
reassigns both sides in one transaction - a half-completed swap would be a
real data-integrity bug, worse than not swapping at all.

## Consequences
- Verified with a real, non-mocked integration test
  (`tests/integration/test_marketplace_claim_locks_assignment.py`):
  publishing an actual `ShiftClaimApproved` message to a real NATS causes
  the real consumer (running inside the same `TestClient(app)` process
  every other integration test in this suite already boots) to reassign
  and lock a real `ShiftAssignment` row, and a subsequent real
  re-optimization keeps it locked - the exact proof §4 step 7 demands,
  not an assumption.
- `EligibilityViolation`'s `stale_shift`/`stale_post` categories and this
  ADR's own consumer both now share one more property worth naming
  explicitly: a marketplace action can still race against an out-of-band
  Module 04 change (a manual override) between validation and NATS
  delivery. This phase does not add an "expected prior employee" guard on
  the consumer side (Module 07 doesn't currently capture who currently
  holds a shift at post-creation time to supply one) - a known, narrower
  gap than the ones this phase closed, flagged rather than silently
  assumed away, and a reasonable candidate for Phase 8's hardening pass.
- Bid-to-assignment commit is explicitly **not** built this phase - §4
  step 7 names `ShiftClaimApproved`/`SwapExecuted` only, and `Bid` has no
  `approved`/terminal-commit concept in its own schema (§2.1). A bid
  winner becoming a real locked assignment is unscoped work, not silently
  implied by this ADR.
