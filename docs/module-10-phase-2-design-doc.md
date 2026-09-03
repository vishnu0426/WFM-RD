# Module 10 Phase 2 Design Doc — AI Layer: Query Router + `explainSchedule` End to End

**Status:** Approved for implementation
**Owner:** AI Layer pod, with the Principal AI Safety/Security Engineer
role owning §5.1's tenant-scoping assertion specifically — this phase is
the first place in the whole build where real multi-tenant structured data
is actually assembled and handed to an LLM, so it is where §5.1 has to be
real, not just designed.
**Scope:** `explainSchedule(scheduleId)` end to end against Module 04
only — §9's own instruction to "get the gRPC-retrieve → LLM-translate →
store pattern correct for one module before generalizing." Includes a
deliberate, explicit mid-build deviation from §1: tenant-selectable,
bring-your-own-key LLM providers (Anthropic + OpenAI) instead of a single
platform-wide Anthropic integration — see ADR-0117.

## Problem

Four real gaps surfaced building this phase, none of them assumable away:

1. **§1's "gRPC to Modules 03/04/05/08/09" assumes a `ScheduleExplanation`
   read contract that does not exist.** Confirmed by inspection (the same
   discipline ADR-0059/ADR-0111 already established): scheduling-service's
   real gRPC surfaces don't serve a `ScheduleJob`'s own solve-result
   columns, and the only real Module 04↔Module 10 contract that was ever
   built (Phase 6, ADR-0059) is a write-only REST handoff. See ADR-0115 —
   this phase adds the missing read half as a new gRPC surface on
   scheduling-service itself, the same "the owning service builds the read
   contract" posture ADR-0059's `ForecastService.GetForecastRequirements`
   already established.
2. **§5.1's tenant-scoping assertion needs something concrete to check.**
   A gRPC response scoped correctly by the owning module's own RLS has
   nothing for a defense-in-depth assertion to verify unless it explicitly
   echoes the tenant id it actually served, rather than just parroting the
   request's own field. `ScheduleExplanationDataService`'s response
   includes `tenant_id`, sourced from the persisted row, specifically for
   this.
3. **`SubmitExplanationRequest.generatedByModelId` is typed `uuid`, but
   this module's own model identifiers are strings** (an Anthropic/OpenAI
   model id, never a uuid from any registry that exists in this platform).
   Disclosed and sent as `null` rather than faked — see ADR-0116.
4. **§1's "Anthropic only" default was explicitly overridden mid-build.**
   Asked directly, the platform owner chose tenant-selectable,
   bring-your-own-key providers (both Anthropic and OpenAI) over the
   spec's single-provider default. See ADR-0117 for the full decision and
   its consequences — recorded as a deliberate override, not a discovered
   spec gap.

## Decisions

- **`ScheduleExplanationService`** is the full §6.2 pipeline for one
  interaction type: gRPC-retrieve (`SchedulingGrpcClientService`) → §5.1
  assertion (`TenantScopeAssertionService`) → resolve the tenant's BYOK
  provider (`AiProviderConfigService.resolveForCall`) → `LlmClient.complete`
  with a fixed system prompt (§5.2) → parse/validate the JSON response →
  compute `confidence_indicator` → persist `AIInteraction` → audit
  (`AuditGrpcClientService`, §2.2 rule 3) → write back to scheduling-service
  (`SchedulingWritebackClientService`).
- **§4's degraded-mode path, minimal but real**: `LlmCallFailedError`
  *and* `AiProviderNotConfiguredError` both fall back to returning the raw
  structured data already retrieved from scheduling-service,
  `degraded_mode = true`, `output_text = null` — never a crash, never a
  fabricated explanation. The full circuit breaker (trip/half-open/retry)
  is explicitly Phase 7's job; this phase only needs "one failed call
  degrades gracefully," which it does.
- **`confidence_indicator` is a documented, executable formula**
  (`computeConfidenceIndicator`, §0.5's "not a cosmetic field" ask): `0.5 ×
  selfReportedConfidence + 0.5 × groundedness`, where groundedness is the
  fraction of numeric tokens in the model's own summary that are also
  traceable, verbatim, to the serialized `input_context`.
- **§5.2's prompt structure**: a fixed system prompt (never includes
  tenant data or end-user text) plus the retrieved structured data as the
  user-content block, explicitly instructed as data-to-describe, not
  instructions-to-follow. This interaction type has no tenant-authored
  free-text field in its input (unlike a future `SpecialEvent` note or
  `LeaveRequest` reason) — the free-text-specific mitigation §5.2 calls for
  is deferred to whichever future interaction type first actually pulls
  one, not fabricated here against data that doesn't contain any.
- **BYOK provider resolution** (ADR-0117): `ProviderRoutingLlmClient`
  takes credentials per call, never holds them across requests.
  `configureAiProvider`/`aiProviderConfig` GraphQL operations exist but are
  not RBAC-gated in this phase (no auth/RBAC guard exists anywhere in this
  service yet) — flagged loudly, not quietly, since the write in question
  is a secret credential.

## Consequences / Verification

- **Real, live boot verification** in this session: real Postgres
  (migrations applied for both new tables), real NATS (the new
  `AGNO_AI_LAYER_EVENTS`/`AGNO_AI_LAYER_DLQ` streams provisioned and
  confirmed created), a real `NestFactory.create` → `app.listen` boot with
  the full dependency graph (gRPC clients, GraphQL schema generation,
  TypeORM) resolving successfully. The generated `src/schema.gql` was
  inspected directly and matches the intended surface exactly:
  `explainSchedule(scheduleId: ID!): AIInteraction!`,
  `configureAiProvider(...)`, `aiProviderConfig`.
- **25 unit tests, all passing** — `confidence-indicator`,
  `parse-schedule-explanation-response`, `TenantScopeAssertionService`,
  `AiProviderCredentialCipherService` (including a tamper/auth-tag-mismatch
  case), and `ScheduleExplanationService`'s full orchestration (happy path,
  not-found, cross-tenant rejection, LLM-failure degraded mode,
  not-configured degraded mode).
- **`ScheduleExplanationDataService` (the new scheduling-service gRPC
  surface) is real and correctly wired** — confirmed via a clean
  `app.main` import, a live gRPC call reaching the exact intended query
  path, and a dedicated integration test suite
  (`test_schedule_explanation_data_grpc.py`, 3 cases). **Full happy-path
  verification (submit a job → worker completes it → read it back) is
  blocked in this specific sandbox by a pre-existing, unrelated
  environment gap**: `CalendarService.GetWorkingTimeRules` (core's gRPC
  server, port 5000) answers with an HTTP/1.1 403 instead of gRPC/HTTP2 in
  this session, which fails *every* job submitted through the real worker
  regardless of which test triggers it — reproduced identically by the
  pre-existing, unmodified `test_schedule_query_grpc.py`, proving this is
  not caused by this phase's change. Not glossed over; recorded honestly
  in the readiness checklist below.
- What's next: `explainForecast`/`reallocationRationale`/`root_cause_analysis`
  (Phase 4), governance/`AIRecommendation` lifecycle (Phase 5), `askQuestion`
  (Phase 6), the full circuit breaker (Phase 7), prompt-injection hardening
  + observability dashboards (Phase 8).
