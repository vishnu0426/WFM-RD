# ADR-0125: `AIRecommendation.org_unit_id` nullable, `AIGovernancePolicy.updated_by` nullable, and `updateGovernancePolicy`'s disclosed RBAC gap

## Context
Three smaller, real gaps surfaced wiring §6.1's named operations to the schema Phase 1 already built:

1. `pendingRecommendations(orgUnitId)` is a real, named query parameter, but `AIRecommendation` (Phase 1's own schema) had no `org_unit_id` column - and the one recommendation source this phase actually builds (`reallocation_rationale`) can't supply one anyway, since `ReallocationAction` itself has no `org_unit_id` column (ADR-0122's own disclosed limitation).
2. `AIGovernancePolicy.updated_by` was `NOT NULL` since Phase 1, written before `updateGovernancePolicy` had a real caller - and this module has no user-identity resolution anywhere yet (the same disclosed gap `AIInteraction.user_id`'s own nullability already carries for every other resolver).
3. `updateGovernancePolicy` is explicitly "admin-only, per Module 01 RBAC" in the spec's own words, but no auth/RBAC guard exists anywhere in this service (ADR-0014's placeholder, restated at every phase this pattern recurs).

## Decision
- `org_unit_id` added as a **nullable** column (additive migration) - `null` for every reallocation-sourced recommendation today, honest rather than guessed. `pendingRecommendations(orgUnitId: ID)` filters to matching rows when supplied; a `null`-org-unit-id recommendation simply never appears in an org-unit-scoped call - a real, disclosed gap in usefulness, not a bug.
- `updated_by` changed to nullable (additive migration) - `updateGovernancePolicy` passes `null` rather than a fabricated id.
- `updateGovernancePolicy` ships real, callable, and **not RBAC-gated** - the same posture `configureAiProvider` (ADR-0117) already established, flagged with the same or greater loudness: this mutation controls whether an `action_type` can execute *without* a human in the loop at all, at least as sensitive as a stored BYOK credential.

## Consequences
- Every field added this phase follows the same rule this module has followed since Phase 1: a schema gap surfaced by a real, named requirement gets a real, additive migration - never a workaround that hides the gap (e.g. defaulting `org_unit_id` to some sentinel value, or fabricating a `updated_by` uuid).
- Both readiness checklists (Phase 5's own, and by reference every prior phase's `configureAiProvider` gap) should be read together before this module handles real production tenant data - RBAC on governance-affecting and credential-affecting mutations is not "later phase polish," it is a real, load-bearing security gap today.
