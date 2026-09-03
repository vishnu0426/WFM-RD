# Module 10 Phase 5 Production Readiness Checklist

**The single most important line in this checklist**: non-negotiable #1's "the LLM never writes to operational tables" claim is now **live-verified**, not just designed - a real, running intraday-service instance had its real `reallocation_action` row executed via a real HTTP call, triggered through this module's own governance gate, in this session. This is the strongest verification any single claim in this module's build has received so far.

## Delivered in this phase (application code)

- [x] `AiGovernancePolicyResolverService` - §3's three-tier resolution order (exact match → tenant `'default'` → hardcoded platform constant), for real.
- [x] `AiGovernancePolicyService` + `updateGovernancePolicy` mutation - upserts on `(tenant_id, action_type)`.
- [x] `RiskThresholdEvaluatorService` - two real, evaluated criteria (`maxAffectedEmployees`, `minConfidenceIndicator`); fails closed on an unconfigured/unrecognized-only config.
- [x] `AiRecommendationService` - full lifecycle: `createFromInteraction` (governance resolve → risk evaluate if applicable → persist → audit → NATS publish → execute-if-gate-open) and `decideRecommendation` (validate → persist decision → audit → NATS publish → execute-if-approved-and-not-suggest_only).
- [x] `ReallocationExecutionClientService` - the write-back-through-owning-module pathway, calling intraday-service's own, already-existing approve endpoint. Not best-effort - a failure here is a real, propagated error.
- [x] `AiNatsClientService` (this module's first NATS presence) + `AiRecommendationEventPublisherService` - `AIRecommendationCreated`/`AIRecommendationDecided` on the `AGNO_AI_LAYER_EVENTS` stream provisioned in Phase 2.
- [x] Three additive migrations: `AiRecommendation.org_unit_id` (nullable), `AiRecommendation.resolved_autonomy_level` (backfilled `approve_required` for any pre-existing row), `AiGovernancePolicy.updated_by` (nullable).
- [x] GraphQL: `pendingRecommendations(orgUnitId)`, `decideRecommendation`, `updateGovernancePolicy` (all three named in §6.1), plus this module's own `createReallocationRecommendation` entry point.
- [x] 72 unit tests total (up from 42), all passing.

## Explicitly NOT done here (later phases, named in §9)

- [ ] `askQuestion`/NL query, human-in-the-loop confirmation (Phase 6).
- [ ] The full circuit breaker (Phase 7) - `AiRecommendationService` inherits the same minimal-but-real degraded-mode posture every prior phase's services use; nothing new here.
- [ ] Recommendation creation for `scheduling`/`forecasting`-sourced interactions - deliberately scoped out (ADR-0123): no write-back execution client exists for either, and a recommendation that can be "approved" but never executes anything would be worse than not offering it.
- [ ] `maxOvertimeCostImpact` (§3's third named risk criterion) - no cost-data source exists anywhere in this platform for any recommendation type this module has built. Named in a `risk_threshold_config` today, it has no effect - disclosed in ADR-0124, not silently ignored.
- [ ] Org-unit-scoped `pendingRecommendations` for reallocation-sourced recommendations specifically - `org_unit_id` is always `null` for them (ADR-0122's own limitation propagates here), so an org-unit-scoped call never returns one.

## Verification performed

- [x] `npm run typecheck` / `npm run build` / `npm test` (72/72) on ai-layer-service - clean.
- [x] **A real, live, end-to-end cross-service test** - not mocked: a genuine `node dist/src/main.js` intraday-service instance running and healthy, seeded `reallocation_action` (`status: suggested`) and `ai_interaction` (`reallocation_rationale`, non-degraded) rows in the real Postgres, then a real in-process `AiRecommendationService` exercised via three cases:
  1. `approve_required` → `decideRecommendation('approved', <real human uuid>)` → recommendation `status: approved` → intraday's real row confirmed `status: executed`, `executed_at` populated.
  2. `auto_execute_low_risk` (thresholds configured to pass) → `createFromInteraction` alone → recommendation `status: auto_executed`, `decided_by: null` → intraday's real row confirmed `status: executed` with zero human involvement.
  3. `auto_execute_low_risk` (a `minConfidenceIndicator` threshold configured to fail against a genuinely low-confidence interaction) → recommendation correctly fell back to `status: suggested`/`requires_human_approval: true` → intraday's real row confirmed still `status: suggested`, untouched.
  4. `pendingRecommendations` (no `orgUnitId` filter) correctly returned exactly the one remaining undecided recommendation (case 3), excluding the decided/auto-executed ones from cases 1-2.
- [x] Full app re-boot (`NestFactory.create` + `app.listen`) against the same running Postgres instance, full dependency graph (now including `AiNatsClientModule`) resolving correctly; `src/schema.gql` inspected directly and confirmed correct.

## Honestly disclosed gaps (not glossed over)

- [ ] **`updateGovernancePolicy` and `configureAiProvider` are both unprotected by RBAC** (ADR-0125, restating ADR-0117's own disclosure with equal or greater urgency) - no auth/RBAC guard exists anywhere in this service. Any tenant-authenticated caller can currently change autonomy levels (including enabling `auto_execute_low_risk` for an `action_type`) or set BYOK credentials. This is the most consequential open item across this module's entire build to date and should be closed before any real tenant traffic reaches this service - it is not "later phase polish."
- [ ] The `suggest_only` advisory-only branch of `decideRecommendation` is unit-tested (mocked) but was **not** exercised in the live cross-service pass above - by design, it has nothing external to call, so a live pass would only re-prove what the mocked test already proves (the execution client is never invoked).
- [ ] No live NATS publish was confirmed to actually land a message on the `AGNO_AI_LAYER_EVENTS` stream and be consumed by anything in this session (no consumer exists anywhere in this platform yet for these subjects) - `AiRecommendationEventPublisherService`'s call shape is unit-tested against a mocked `AiNatsClientService`; the underlying `AiNatsClientService.publish` itself is the exact same, previously-verified-live pattern every sibling service's own NATS client already uses (ADR-0039 precedent), so this is a low-risk, but still real, unverified-in-this-session gap.
- [ ] Load testing, chaos/game-day exercises, a real security/red-team review of §5 - none run this phase, same standing gaps named in every prior phase's own checklist until they're actually done. The RBAC gap above makes this review more urgent with each phase that adds another unprotected write, not less.
