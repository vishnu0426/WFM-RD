# ADR-0124: the write-back-through-owning-module execution pathway, and the two real `auto_execute_low_risk` criteria

## Context
Non-negotiable #1 is unambiguous in principle ("the governed pathway executes the deterministic action the recommendation described, using the same operational service/API another human-initiated action would use") but names no concrete API for any real recommendation type. §3 similarly names example risk criteria ("affects fewer than N employees," "no overtime cost impact," "confidence_indicator above X") without saying which are actually implementable given this platform's real data.

## Decision
**Execution pathway**: `ReallocationExecutionClientService.approveReallocation(tenantId, reallocationActionId)` calls intraday-service's own, already-existing `POST /v1/intraday/reallocations/{id}/approve` - the exact endpoint a human supervisor's `approveReallocation` GraphQL mutation already calls. Module 10 never writes to `intraday.reallocation_action` itself, at any autonomy level, including `auto_execute_low_risk` - the "auto" only ever means "no human approval step blocks it," never "a different, AI-owned write path." Unlike `SchedulingWritebackClientService`'s best-effort explanation write-back (Phase 2), this call's failure is a real, propagated error (`ReallocationExecutionFailedError`) - it *is* the governed action, not a side-effect audit trail.

Only `source_module: 'intraday'` has a real client wired. `scheduling`/`forecasting`-sourced recommendations (not built by this phase - see ADR-0123's own scope) would need their own write-back clients before they could ever reach `approved`/`auto_executed`; attempting to execute one today throws a plain, undecorated error inside `AiRecommendationService.execute`, since no `source_module` other than `intraday` can currently reach that code path (Phase 5's own `createFromInteraction` only accepts `reallocation_rationale` interactions - see `AiInteractionNotRecommendableError`).

**Risk criteria**: only two of §3's three named examples are real, evaluated criteria (`RiskThresholdEvaluatorService`):
- `maxAffectedEmployees` - checked against the recommendation's own affected-employee count.
- `minConfidenceIndicator` - checked against the generating `AIInteraction.confidence_indicator` (§0.5's own documented formula).

`maxOvertimeCostImpact` (§3's third example) is NOT implemented - no recommendation source this module has built carries cost data anywhere in its own structured data; naming it in a tenant's `risk_threshold_config` has no effect. A config with **no recognized criteria at all** fails closed (never auto-executes), the same "an unconfigured gate defaults to the safest outcome" posture ADR-0114 already established for the autonomy-resolution order itself.

## Consequences
- **Live-verified for real** in this session, not just unit-tested against mocks: a genuine running intraday-service instance, seeded `reallocation_action`/`ai_interaction` rows, and a real in-process `AiRecommendationService` call chain proved all three real code paths:
  1. `approve_required` → `decideRecommendation('approved')` → the real intraday row flipped from `suggested` to `executed` via a real HTTP call.
  2. `auto_execute_low_risk` with passing thresholds → immediate `auto_executed` status, `decided_by: null`, and the same real row flip - zero human involvement.
  3. `auto_execute_low_risk` with a failing `minConfidenceIndicator` threshold → correctly fell back to `suggested`/`requires_human_approval: true`, and the real intraday row was correctly left untouched.
- If `maxOvertimeCostImpact` (or any other risk criterion) is ever needed for real, it requires a real cost-data source first - not a code change to the evaluator alone, which would otherwise silently gate on data that doesn't exist.
