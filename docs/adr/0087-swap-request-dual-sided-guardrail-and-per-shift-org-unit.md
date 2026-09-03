# ADR-0087: `SwapRequest` runs two independent guardrail checks (one per side of the trade), reuses the claim contention lock for the open-swap-accept race, and gains per-shift `org_unit_id`/`validation_result` columns beyond the source spec's abbreviated DDL

## Context
§8 Phase 3's own instruction is to build `SwapRequest`'s peer-to-peer flow
"reusing the same guardrail validation path as claims (not a separate
implementation)." Taking that literally exposed two things the source
spec's abbreviated §2.1 DDL for `SwapRequest` doesn't name but that
`GuardrailValidationService`/`SchedulingEligibilityService.
CheckAssignmentEligibility` (ADR-0082) actually require to be called
correctly for a swap:

1. **A swap is two assignment changes, not one.** Accepting a swap moves
   the initiator into the target's shift *and* the target into the
   initiator's shift, simultaneously. Calling the guardrail check only
   once (e.g. just "is the initiator eligible for the target's shift")
   would silently skip verifying the other direction - exactly the kind
   of approximation §0's non-negotiable forbids, just applied to a
   two-sided action instead of `ClaimOpenShiftService`'s one-sided claim.
2. **`CheckAssignmentEligibility` needs an `org_unit_id` per call**, to
   resolve that call's own candidate's active `EmploymentPolicy`
   (`PolicyService.GetActivePolicy` is org-unit-scoped). A swap's two
   shifts can belong to different org units - one swap-level org unit
   field wouldn't be enough, the same way `MarketplacePost.orgUnitId`
   (added in Phase 2, beyond that entity's own abbreviated DDL too) was
   enough for a claim because a claim only ever involves one shift.

## Decision

**Two independent `checkEligibility` calls per accept**, run concurrently
(`Promise.all`): one asking "would the initiator be eligible for the
target's shift" (excluding the initiator's own given-up shift from their
existing-assignments set), one asking "would the target be eligible for
the initiator's shift" (excluding the target's own given-up shift). Both
must pass for the swap to be accepted; either failing rejects the whole
swap, with `validationResult.initiatorViolations`/`responderViolations`
attributing which side (or both) actually failed and why - the same "clear
reason on rejection" principle §4 step 2 states for `MarketplaceClaim`,
extended to a two-sided action.

**`SwapRequest` gains three columns beyond the source spec's abbreviated
DDL**: `initiatorOrgUnitId` (required, known at `proposeSwap` time - the
initiator already knows their own shift's org unit), `targetOrgUnitId`
(nullable, following `targetShiftId`'s own nullable-until-known lifecycle
exactly - both become known together, either at `proposeSwap` for a closed
swap or at `respondToSwap` for an open one), and `validationResult` (jsonb,
mirroring `MarketplaceClaim`'s own field for the same audit/explainability
reason).

**The open-swap-accept race reuses `MarketplaceRedisService.
acquireClaimLock`/`releaseClaimLock`** (the same primitive Phase 2 built
for the claim flow, ADR-0085), keyed on `swapRequestId` instead of
`marketplacePostId` - two different employees racing to accept the same
open swap is the identical "exactly one concurrent winner, immediate
fast-fail for the loser" shape as two employees racing to claim the same
open shift. The shared TTL constant moved to
`contention-lock.constants.ts` so both call sites cite the same rationale
rather than duplicating it. The lock is taken unconditionally on every
accept attempt (closed or open), not only when a real cross-employee race
is possible - a closed swap's own named target double-submitting
concurrently is a lower-severity version of the same race, and locking
unconditionally keeps the code path uniform rather than branching on
open-vs-closed to decide whether to lock.

**Same fail-closed shape as `ClaimOpenShiftService` for both Redis and
guardrail-gRPC failures** (§0.5's chaos scenarios) - a guardrail-call
failure mid-accept marks the swap `rejected` with a transient reason
(`guardrail_validation_unavailable`) rather than leaving it stuck with a
resolved target and no verdict, the same fix Phase 2 needed for the claim
flow's own equivalent gap.

## Consequences
- `respondToSwap`'s reject path is intentionally narrower than accept: an
  open swap (no named target) cannot be rejected via `respondToSwap` at
  all - there's no one specific it was addressed to reject on behalf of.
  Only a closed swap's exact named target may reject it. Cancelling one's
  own proposed swap (by the initiator, before anyone responds) is not a
  mutation this phase builds - §3.1 names `proposeSwap`/`respondToSwap`
  only; a `cancelSwap` mutation would be new, unrequested surface.
- Auto-vs-supervisor-approval and the Module 04 NATS handoff remain Phase 5
  scope, unchanged from how Phase 2 scoped the equivalent claim-flow
  concern - an `accepted` `SwapRequest` is validated-and-agreed, not yet
  committed to Module 04's `ShiftAssignment` table.
- This module's guardrail-validation surface is now exercised in both its
  one-sided (claim) and two-sided (swap) shapes without any change to
  `GuardrailValidationService`/`SchedulingEligibilityGrpcClientService`
  themselves - real evidence the shared abstraction fits both call
  patterns, not just the one it was originally written for.
