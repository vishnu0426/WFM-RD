# Module 10 Phase 2 Production Readiness Checklist

**The single most important line in this checklist**: `explainSchedule` is
real, end-to-end, live-boot-verified, and covered by 25 passing unit
tests — but it uses a **deliberately overridden** provider model (tenant
BYOK, not §1's platform-wide Anthropic default, ADR-0117) and its full
happy-path integration test against a live worker is currently blocked by
a pre-existing, unrelated environment gap in this sandbox (below). Neither
of those is glossed over here.

## Delivered in this phase (application code)

- [x] `ScheduleExplanationService` — the full §6.2 pipeline: gRPC-retrieve
      → §5.1 tenant-scoping assertion → BYOK provider resolution → LLM call
      → parse/validate → `confidence_indicator` → `AIInteraction` persist →
      audit (§2.2 rule 3) → write-back to scheduling-service.
- [x] `ScheduleExplanationDataService.GetScheduleJobForExplanation` — a new
      gRPC surface added to **scheduling-service itself** (ADR-0115),
      closing the read-side gap §1's own assumed contract didn't actually
      have anywhere in this repo. Echoes `tenant_id` from the persisted
      row specifically for §5.1's assertion to check against.
- [x] `TenantScopeAssertionService` — §5.1's explicit assertion step, real
      and unit-tested (match, mismatch, first-mismatch-wins, metric
      recording, security-level log line on failure).
- [x] `AiProviderConfig` (new entity, ADR-0117) + `AiProviderCredentialCipherService`
      (AES-256-GCM, real encryption, unit-tested including a tamper/
      auth-tag case) + `AiProviderConfigService` (configure/resolve,
      never returns a decrypted key from any query) +
      `ProviderRoutingLlmClient` (real, live Anthropic and OpenAI branches
      — neither is a stub).
- [x] `configureAiProvider`/`aiProviderConfig` GraphQL operations —
      write-only credential, upserts, never echoes the key back.
- [x] §4's minimal, real degraded-mode path: `LlmCallFailedError` and
      `AiProviderNotConfiguredError` both fall back to the raw structured
      data already retrieved, `degraded_mode = true`, never a crash, never
      fabricated output. (The full circuit breaker is explicitly Phase 7 —
      not attempted here.)
- [x] `AuditGrpcClientService` (core's `AuditService.RecordEvent`,
      `actor_type: ai_agent`) wired into every `explainSchedule` call,
      satisfying §2.2 rule 3's platform-wide non-negotiable for the first
      time in this module's own build. Best-effort — a failure here never
      fails the caller's already-successful `AIInteraction`.
- [x] `SchedulingWritebackClientService` — REST call back to Module 04's
      already-existing `POST /v1/scheduling/jobs/{jobId}/explanation`.
      Best-effort for the same reason as the audit client; `generatedByModelId`
      is always `null` (ADR-0116's disclosed contract mismatch, not faked).
- [x] `AGNO_AI_LAYER_EVENTS`/`AGNO_AI_LAYER_DLQ` NATS streams provisioned
      (`scripts/provision-nats-streams.ts`) — not yet published to (Phase
      5), same "declared ahead of its first real publisher" posture Module
      05's own `AGNO_INTRADAY_DLQ` took.
- [x] `AiLlmProvider`/`AiInteractionType` GraphQL enums, `JSON` scalar,
      `DomainErrorFilter`/`formatGraphQLError` mappings for every new error
      type (`ScheduleJobNotFoundError`, `SchedulingGrpcClientUnavailableError`,
      `CrossTenantDataAssemblyError`, `LlmCallFailedError`,
      `AiProviderNotConfiguredError`).

## Explicitly NOT done here (later phases, named in §9)

- [ ] `explainForecast`/`reallocationRationale`/`root_cause_analysis`
      (Phase 4). `AIRecommendation`/`AIGovernancePolicy` lifecycle,
      `AiGovernancePolicyResolverService`, risk-threshold evaluation
      (Phase 5). `askQuestion`/NL query (Phase 6). The full circuit
      breaker with trip/half-open/retry (Phase 7 — this phase's degraded
      mode is real but minimal, a single try/catch, not a stateful
      breaker). Prompt-injection test suite, dashboards, runbook (Phase 8).
- [ ] **RBAC on `configureAiProvider`.** No auth/RBAC guard exists
      anywhere in this service yet (ADR-0014's placeholder). Flagged more
      loudly than the usual "RBAC comes later" note: this write sets a
      secret credential, and today any tenant-authenticated caller can set
      or overwrite it. Do not treat this as routine Phase-1-style
      placeholder debt — close it before any real tenant key is ever
      stored.
- [ ] **KMS-backed encryption-key management.** `AI_PROVIDER_CREDENTIAL_ENCRYPTION_KEY`
      is a single static env var; a real deployment needs rotation and a
      real secrets manager, not this. The encryption itself (AES-256-GCM,
      random IV) is real and correct — the *key's own* storage/lifecycle is
      the gap.
- [ ] §5.2's tenant-authored-free-text mitigation is designed but has no
      real trigger yet — `explainSchedule`'s own input data (constraint
      config, relaxation figures) contains no tenant-authored free text to
      exercise it against. The first interaction type that pulls one (a
      `SpecialEvent` note, a `LeaveRequest` reason) is where this actually
      needs to be exercised for real.
- [ ] A genuine security/red-team review of §5's mechanism (§5.2's own
      standing requirement, restated at every phase until it happens) —
      this phase built real mitigations, it did not substitute for that
      review.

## Verification performed

- [x] `npm run typecheck` / `npm run build` / `npm test` (25/25 passing) —
      all clean, re-run after the mid-build BYOK provider rework, not just
      before it.
- [x] **Real, live boot** of the full app (`NestFactory.create` +
      `app.listen(0)`) against a real running Postgres (with both
      migrations actually applied via `npm run migration:run`) and a real
      running NATS in this session — confirmed by inspecting the
      auto-generated `src/schema.gql` directly, not just a passing exit
      code.
- [x] **`ScheduleExplanationDataServicer` (scheduling-service's new gRPC
      surface) verified real**: `app.main` imports cleanly with it
      registered, a hand-rolled script reached its exact query path over a
      real Postgres connection, and its own integration test suite
      (`test_schedule_explanation_data_grpc.py`) exercises found/not-found/
      malformed-id paths — the malformed-id case passes for real; the
      found/completed-job case is blocked by the gap below.
- [ ] **Full end-to-end happy path (submit a job → worker completes it →
      `GetScheduleJobForExplanation` returns real solve data) is blocked
      in this specific sandbox**, not by anything this phase built:
      `CalendarService.GetWorkingTimeRules` (core's own gRPC server, port
      5000) answers with an HTTP/1.1 403 instead of gRPC/HTTP2 in this
      session, which fails *every* schedule job the real worker processes.
      Proven pre-existing and unrelated by reproducing the identical
      failure against `test_schedule_query_grpc.py`, a file this phase
      never touched. Whoever next has a working core gRPC server reachable
      should re-run `test_schedule_explanation_data_grpc.py`'s first two
      cases to close this out — the code is believed correct, but "believed
      correct" is exactly the phrase this platform's own convention
      insists on flagging rather than silently upgrading to "verified."
- [ ] No live call was ever made to a real Anthropic or OpenAI API with a
      real key in this session (none was provided/available) —
      `ProviderRoutingLlmClient`'s two branches are exercised only via
      mocked `LlmClient.complete` in `ScheduleExplanationService`'s own
      unit tests, not against a live provider endpoint.
- [ ] Load testing, chaos/game-day exercises (§0.5's own named chaos
      scenarios: LLM API unreachable, crafted cross-tenant query) — not
      run this phase. The degraded-mode path is unit-tested with a
      simulated failure, which is the closest approximation possible
      without live provider credentials, but is not the same as an actual
      game-day exercise against a running instance.
