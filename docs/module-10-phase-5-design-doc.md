# Module 10 Phase 5 Design Doc — AI Layer: Governance & Recommendation Pathway

**Status:** Approved for implementation
**Owner:** AI Layer pod.
**Scope:** §9's own Phase 5 line: "`AIGovernancePolicy` resolution (§3), `AIRecommendation` lifecycle, the write-back-through-owning-module execution pattern." The centerpiece of non-negotiable #1 - this is the phase where "the LLM never writes to operational tables" stops being a design intention and becomes a real, live-tested code path.

## Problem

Three real ambiguities needed resolving before this phase's code could be written, not discovered mid-implementation:

1. **What does `suggest_only` vs. `approve_required` actually mean for execution?** Both resolve `requires_human_approval: true` at the schema level (ADR-0113) - nothing distinguished them further. Resolved in ADR-0123: `suggest_only` never executes, even once a human marks it "approved" - purely advisory.
2. **What does the write-back pathway actually call?** Resolved in ADR-0124: intraday-service's own, already-existing `POST /v1/intraday/reallocations/{id}/approve` - the identical endpoint a human supervisor's own `approveReallocation` mutation already calls. No new owning-module endpoint was built; none was needed.
3. **Which `auto_execute_low_risk` criteria are real?** Resolved in ADR-0124: only `maxAffectedEmployees` and `minConfidenceIndicator` - both backed by data this module actually has. §3's third named example (`maxOvertimeCostImpact`) has no data source anywhere in this platform and is not implemented; naming it in a config has no effect, and a config with no recognized criteria at all fails closed.

A fourth, smaller set of gaps (ADR-0125): `AIRecommendation` had no `org_unit_id` column (§6.1 names `pendingRecommendations(orgUnitId)`), and `AIGovernancePolicy.updated_by` was `NOT NULL` with no real caller identity to populate it. Both closed with small, additive migrations rather than fabricated values.

## Decisions

- **Scope decision, stated explicitly**: only `reallocation_rationale` interactions can become an `AIRecommendation` in this phase (`AiInteractionNotRecommendableError` for any other type) - it's the only interaction type with a real, governed execution pathway wired. Building `scheduling`/`forecasting` recommendation creation without a real write-back client for either would mean recommendations that can be "approved" but never actually do anything - a worse outcome than not building them yet.
- **`AiGovernancePolicyResolverService`** implements ADR-0114's exact three-tier order in code for the first time: exact `action_type` match → the tenant's own `'default'` row → the hardcoded platform constant (`suggest_only`), never a database row for the third tier.
- **`AiRecommendationService`** is the full lifecycle: `createFromInteraction` (resolve governance → evaluate risk if `auto_execute_low_risk` → persist → audit → publish `AIRecommendationCreated` → execute immediately if the gate is already open) and `decideRecommendation` (load → validate `status: suggested` → persist the decision → audit → publish `AIRecommendationDecided` → execute if `approved` and the autonomy level allows it).
- **This module's first NATS presence** (`AiNatsClientService`, own copy of every other standalone service's identical client per ADR-0039) - the `AGNO_AI_LAYER_EVENTS` stream, provisioned in Phase 2, gets its first real publisher three phases later. Best-effort, fire-and-forget, the same convention every other standalone service's own NATS publisher follows - no durable outbox table, matching this platform's own precedent for standalone (non-monolith) services.

## Consequences / Verification

- **The single most important verification in this module's build so far**: a real, running intraday-service instance, seeded Postgres rows, and a real in-process `AiRecommendationService` call chain proved non-negotiable #1's own governed pathway for real, not as an assertion:
  - `approve_required` → human `'approved'` decision → the real `reallocation_action` row flipped from `suggested` to `executed` via a genuine HTTP call to intraday-service's own approval endpoint.
  - `auto_execute_low_risk` with passing thresholds → immediate `auto_executed`, `decided_by: null`, the same real row executed with zero human involvement.
  - `auto_execute_low_risk` with a failing threshold → correctly fell back to `suggested`/`requires_human_approval: true`, and the real row was correctly left untouched (still `suggested`).
  - `pendingRecommendations` correctly returned only the one remaining undecided recommendation after the above.
- 72 unit tests (up from 42), all passing - governance resolution's three-tier order, risk evaluation (pass/fail/fail-closed-on-unconfigured/partial-config), the full recommendation lifecycle including the `suggest_only` advisory-only branch (not exercised in the live pass, since by design it has nothing external to call), the execution client's success/failure/default-URL cases, and the event publisher's best-effort-swallow behavior.
- `npm run typecheck`/`build`/`test` clean; a full app re-boot against the same running Postgres instance succeeds; `src/schema.gql` inspected directly confirms `pendingRecommendations`/`decideRecommendation`/`updateGovernancePolicy`/`createReallocationRecommendation` all present with the expected signatures.
- What's next: Phase 6 (`askQuestion`/NL query, human-in-the-loop confirmation), Phase 7 (the full circuit breaker), Phase 8 (prompt-injection test suite, dashboards, the real security review - which now also needs to cover `updateGovernancePolicy`'s and `configureAiProvider`'s shared RBAC gap, the most consequential open item across this module's entire build so far).
