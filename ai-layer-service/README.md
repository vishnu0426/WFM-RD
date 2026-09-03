# AGNO WFM — Module 10: AI Layer (Cross-Cutting Orchestration & Reasoning)

**Phases 1–5 of the source spec's 8-phase build are complete.** Phase 1
(Schema & Migrations) — see `docs/module-10-phase-1-design-doc.md` and
ADR-0113/0114. Phase 2 (Query router + `explainSchedule` end to end
against Module 04, plus a deliberate mid-build deviation to
tenant-selectable BYOK LLM providers) — see
`docs/module-10-phase-2-design-doc.md` and ADR-0115/0116/0117. Phase 3
(§5.1's tenant-scoping assertion made durable — a real, queryable audit
event on violation, not just an in-process log line) — see
`docs/module-10-phase-3-design-doc.md` and ADR-0118. Phase 4
(`explainForecast`/`explainReallocation` against Modules 03/05, plus the
first multi-module `rootCauseAnalysis`) — see
`docs/module-10-phase-4-design-doc.md` and ADR-0119/0120/0121/0122. Phase 5
(governance resolution + the `AIRecommendation` lifecycle + the
write-back-through-owning-module execution pathway — **live-verified
against a real running intraday-service**) — see
`docs/module-10-phase-5-design-doc.md` and ADR-0123/0124/0125.

This module is architecturally different from every other module in this
platform: it owns no primary data domain of its own, calls into other
modules exclusively via gRPC, and is the only module that assembles
multi-tenant structured data into an LLM call. §5 (prompt injection /
cross-tenant leakage) is treated with the same seriousness as any other
module's own hard-constraint non-negotiable.

## What's in Phase 1 (schema & migrations)

- Full DDL for `AIInteraction`/`AIRecommendation`/`AIGovernancePolicy`
  (§2.1) — `src/database/migrations/1700009000000-InitialAiLayerSchema.ts`.
- New `ai_layer` schema + `agno_ai_app` role (ADR-0113) — uniformly
  tenant-scoped RLS on all three tables; no nullable-tenant-id
  "platform-default" shape anywhere in this module (see the ADR for why
  that's a real decision, not an oversight).
- `AIGovernancePolicy`'s three-tier resolution order (exact `action_type` →
  tenant's own `'default'` row → hardcoded platform `suggest_only`) is
  committed to at the schema level now (ADR-0114), even though
  `AiGovernancePolicyResolverService` itself isn't built until Phase 5.
- The platform's standard tenant-context/health/metrics/domain-error
  scaffold — `/healthz`, `/readyz` (Postgres-gated only — an LLM outage is
  §4's degraded-mode path, never a readiness failure), `/metrics`.

## What's in Phase 2 (query router + `explainSchedule`)

- **`ScheduleExplanationService`** — the full pipeline: gRPC-retrieve from
  scheduling-service → §5.1 tenant-scoping assertion → resolve the
  tenant's own LLM provider → call it → parse/validate the response →
  compute `confidence_indicator` → persist `AIInteraction` → audit (§2.2
  rule 3) → write back to scheduling-service.
- **`ScheduleExplanationDataService`** — a new gRPC surface this phase
  added to **scheduling-service itself** (`../scheduling-service`,
  ADR-0115), since the read contract §1 assumed didn't exist anywhere in
  this platform.
- **A deliberate, explicit deviation from §1's "Anthropic only" default**
  (ADR-0117): each tenant brings their own LLM provider (Anthropic or
  OpenAI) and their own API key, configured via the `configureAiProvider`
  GraphQL mutation and stored encrypted (`AiProviderCredentialCipherService`,
  AES-256-GCM) — never a platform-wide key, never returned by any query.
- `TenantScopeAssertionService` — §5.1's explicit, unit-tested assertion
  step, defense in depth independent of scheduling-service's own RLS.
- §4's degraded-mode path, real but minimal (the full circuit breaker is
  Phase 7): an LLM call failure, or a tenant with no provider configured
  yet, both fall back to returning the raw structured data already
  retrieved — never a crash, never a fabricated explanation.
- GraphQL: `explainSchedule(scheduleId): AIInteraction!`,
  `configureAiProvider(...)`, `aiProviderConfig`.

## What's in Phase 3 (tenant-scoping verification, in full)

- `TenantScopeAssertionService.assertSameTenant` now writes a durable,
  queryable `AuditLog` entry (`actor_type: 'system'`,
  `action: 'security.cross_tenant_data_assembly_detected'`) on every
  violation, not just a log line and a metric (ADR-0118) — §0.5's "page
  accordingly" needs something an incident-response process can actually
  query afterward.
- The audit write is defensively isolated in its own `try`/`catch` — the
  security rejection itself always fires, even if the audit write can't.
- **Honestly disclosed**: core's gRPC server (port 5000) was not reachable
  in this build's sandbox (confirmed with a direct probe) — the actual
  "row lands in `core.audit_log`" outcome could not be demonstrated live.
  See `docs/module-10-phase-3-production-readiness-checklist.md`.

## What's in Phase 4 (remaining explanation types + multi-module root cause analysis)

- **`explainForecast(forecastRunId)`** — same pipeline shape as
  `explainSchedule`, against forecasting-service's new
  `ForecastExplanationDataService` (ADR-0119, joining `ForecastRun`→
  `ForecastModel`→`ForecastAccuracyLog` by run id) — this module's most
  thoroughly live-verified cross-service addition (4/4 real gRPC tests
  against a live Postgres, over a real socket).
- **`explainReallocation(reallocationActionId)`** — against intraday-service's
  brand-new, first-ever gRPC server (`ReallocationService`, ADR-0120) —
  the first interaction type whose retrieved data includes genuine
  tenant-authored free text (`ReallocationAction.reason`), exercising
  §5.2's untrusted-content handling for real for the first time.
- **`rootCauseAnalysis(orgUnitId, periodStart, periodEnd)`** — the first
  multi-module interaction type: adherence-compliance-service's new
  `AdherenceRollupService` (org-unit adherence summary, ADR-0121) combined
  with intraday-service's `ListReallocationsForPeriod` (tenant-wide
  reallocation churn, capped at 100 rows with a disclosed
  `totalMatchedBeforeCap`, ADR-0122). `RootCauseAnalysisNoDataError` only
  fires when *both* sources have nothing — either individually being
  empty is legitimate data, not an error.
- **A real, pre-existing bug found in intraday-service, disclosed and
  deliberately not fixed here** (out of this phase's scope):
  `INestApplication.close()` never resolves once the app has called
  `app.listen()` — reproduced with a script containing none of this
  phase's own changes. See the Phase 4 readiness checklist.

## What's in Phase 5 (governance & recommendation pathway)

- **`AiGovernancePolicyResolverService`** — §3's three-tier resolution
  order for real: exact `action_type` → the tenant's own `'default'` row →
  the hardcoded platform constant (`suggest_only`), never a database row.
- **`AiRecommendationService`** — the full `AIRecommendation` lifecycle:
  `createFromInteraction` (only `reallocation_rationale` interactions
  qualify, ADR-0123's own scope decision) resolves governance, evaluates
  `auto_execute_low_risk` thresholds when applicable
  (`RiskThresholdEvaluatorService` — `maxAffectedEmployees`/
  `minConfidenceIndicator` are the only two real, evaluated criteria,
  ADR-0124), and `decideRecommendation` handles a human's approve/reject
  decision. `suggest_only` never executes anything even once "approved" —
  purely advisory (ADR-0123).
- **The write-back-through-owning-module execution pathway, made real**:
  `ReallocationExecutionClientService` calls intraday-service's own,
  already-existing `POST /v1/intraday/reallocations/{id}/approve` — the
  exact endpoint a human supervisor's own `approveReallocation` mutation
  already calls. Non-negotiable #1's "the LLM never writes to operational
  tables" is not merely designed here — see the live-verification note
  below.
- This module's first NATS presence: `AiRecommendationCreated`/
  `AIRecommendationDecided` publish to the `AGNO_AI_LAYER_EVENTS` stream
  provisioned in Phase 2.
- GraphQL: `pendingRecommendations(orgUnitId)`, `decideRecommendation`,
  `updateGovernancePolicy` (all three named in §6.1), plus this module's
  own `createReallocationRecommendation` entry point.
- **Live-verified end to end, not just mocked**: a real, running
  intraday-service instance, seeded Postgres rows, and a real in-process
  call chain proved all three governance paths for real — human-approved
  execution, automatic low-risk execution, and the risk-threshold
  fallback — each one flipping (or correctly *not* flipping) intraday's
  actual `reallocation_action` row via a genuine HTTP call. See
  `docs/module-10-phase-5-production-readiness-checklist.md` for the full
  detail.
- **Honestly disclosed**: `updateGovernancePolicy` and `configureAiProvider`
  are both unprotected by RBAC — no auth/RBAC guard exists anywhere in
  this service yet. This is the most consequential open item across this
  module's build to date (ADR-0125).

## What's in Phase 6 (`askQuestion` NL query & human-in-the-loop confirmation)

- **`gatherContext` extracted on all four existing interaction-type
  services** (ADR-0126) — a pure refactor, no behavior change, so
  `askQuestion` reuses the exact same gRPC-retrieve + §5.1 assertion +
  shaping logic every prior interaction type already uses, never a fifth
  fetch path.
- **`AskQuestionService`** — the caller supplies exactly one resource
  pointer (`scheduleJobId` / `forecastRunId` / `reallocationActionId` /
  `orgUnitId`+`periodStart`+`periodEnd`), never a free-text description of
  which resource to look up; `askQuestion`'s free-text `question` is
  answered strictly against that one resource's own real data (ADR-0127).
  This module still has no NL-entity-resolution capability, same disclosed
  gap ADR-0111 already named for Module 09.
- **`nl-query-prompt.ts`** — the first interaction type where the *entire*
  input, not a sub-field, is tenant-user-authored free text; the system
  prompt names the `GROUNDING DATA`/`USER QUESTION` blocks explicitly
  (§5.2).
- **No raw-data fallback on LLM failure** — the one deliberate departure
  from every prior interaction type's §4 behavior: an NL answer has no
  non-LLM equivalent, so a failed LLM call still persists a real, audited,
  `degraded_mode: true` interaction row, but the caller gets an explicit
  `AiAssistantUnavailableError` ("AI assistant is temporarily unavailable —
  try the dashboard directly"), never a hollow "successful" response.
- **Human-in-the-loop is structural**: `AiRecommendationService.createFromInteraction`
  only accepts `reallocation_rationale`-typed interactions; `askQuestion`
  always produces an `nl_query`-typed one, so it can never seed an
  `AIRecommendation` — proved directly in `ask-question.service.spec.ts`,
  not just designed.
- GraphQL: `askQuestion(context, question)` — the last §6.1 operation this
  module had not yet built.
- **Live-verified**: a full app re-boot against the same running Postgres
  instance, plus four live GraphQL calls exercising the missing-tenant,
  zero-source, two-source, and valid-source-with-a-downstream-service-down
  paths, each producing the exact expected error. See
  `docs/module-10-phase-6-production-readiness-checklist.md` for the full
  detail.

## What's in Phase 7 (the full LLM circuit breaker)

- **`LlmCircuitBreakerService`** — a real state machine (`closed` → `open`
  after 5 consecutive countable failures → `half_open` after a 30s cooldown,
  exactly one trial call → `closed` on success / back to `open` on
  failure), keyed by **provider** (`anthropic`/`openai`), not by tenant
  (ADR-0128).
- **Classified failures, not every failure** — a tenant's own invalid API
  key (401/403) or a bad request (400/404/422) never counts toward opening
  the shared circuit; only failures with no tenant-specific explanation
  (5xx, 429, timeouts, network errors, malformed responses) do. Without
  this, one tenant's bad key could degrade every other tenant on the same
  provider — the central design problem this phase actually solves.
- **Zero changes to any interaction-generating service** — a short-circuited
  call throws the same `LlmCallFailedError` a real failed call would, so
  every existing `catch` block already built for §4's degraded-mode path
  benefits automatically.
- **Drive-by bug fix**: `LlmCallFailedError`'s message hardcoded "Anthropic"
  regardless of which provider actually failed, since before this phase
  provider attribution in the error message was cosmetic. Fixed,
  backward-compatible with every pre-existing test construction.
- **Metrics, wired for real**: `ai_llm_api_calls_total` gains a
  `short_circuited` result and corrected multi-provider help text;
  `ai_circuit_breaker_state_transitions_total` (declared since Phase 1) is
  now actually observed.
- 17 new unit tests (97 total) — the first in this module's suite to mock
  the real `@anthropic-ai/sdk`/`openai` packages directly, plus the circuit
  breaker's own state machine verified with Jest fake timers. Live-verified:
  a full app re-boot plus a direct `/metrics` inspection confirming both the
  corrected help text and the newly-wired transition metric. See
  `docs/module-10-phase-7-production-readiness-checklist.md` for the full
  detail.

## Multi-provider expansion: Gemini and Ollama (docs/adr/0129)

- **`AiLlmProvider` gains `GEMINI` and `OLLAMA`**, alongside the existing
  `ANTHROPIC`/`OPENAI` (docs/adr/0117). Gemini is a third cloud provider,
  identical BYOK shape to the existing two (`@google/genai`, the actively
  maintained SDK - the older `@google/generative-ai` package has had no
  release since April 2025).
- **Ollama is architecturally different**: self-hosted, so `AiProviderConfig`
  gains a `baseUrl` column (required for `ollama`, unused otherwise) and
  `encryptedApiKey` becomes nullable (most self-hosted Ollama instances are
  unauthenticated - a fabricated key would violate this module's own "never
  fabricate" convention; if a tenant does supply one, it's sent as a Bearer
  header for instances behind an auth proxy).
- **This platform never validates or tunnels to a tenant's self-hosted
  Ollama instance** - reachability is entirely the tenant's own
  responsibility, disclosed explicitly, not silently assumed to work.
- **Independent circuit breakers per provider** (docs/adr/0128) - a Gemini
  or Ollama outage never affects Anthropic/OpenAI-configured tenants, or
  each other. Ollama's own client library has no built-in per-call
  timeout, so `ProviderRoutingLlmClient` wraps it in the same
  `CALL_TIMEOUT_MS` every other provider already respects via a local
  `Promise.race`.
- **A real defensive check, not boilerplate**: `completeWithOllama` throws
  immediately if `baseUrl` is missing rather than trusting `configure`'s
  own validation silently - the client library would otherwise silently
  fall back to `localhost:11434`, a genuinely dangerous wrong-target
  failure mode for a multi-tenant service.
- 23 new unit tests (112 total) - `AiProviderConfigService`'s validation
  rules and `ProviderRoutingLlmClient`'s Gemini/Ollama integration,
  including duck-typing Ollama's own unexported `ResponseError` shape.
  Live-verified: a real migration run, full app re-boot, `src/schema.gql`
  inspected directly, and four live GraphQL calls exercising both
  providers' validation and success paths.

## What's in Phase 8 (prompt-injection verification, RBAC, dashboards)

- **Prompt-injection test suite** (docs/adr/0131) - adversarial, not just
  designed: proves untrusted content can never leak into any system
  prompt's own string, proves a hypothetically-compromised model's extra
  JSON fields (`"action"`, `"autonomyLevel"`, `"execute"`) are silently
  dropped by the parser, and proves governance/autonomy resolution has no
  parameter path for LLM-derived content to enter at all. Two real,
  disclosed exceptions found in the process, not fixed by this suite:
  `confidenceIndicator` can be measurably inflated by a self-reported-
  confidence-plus-context-echo attack (a narrow but real path into a
  security-relevant `auto_execute_low_risk` decision), and `rationaleText`
  reaches the human approver completely unfiltered - human-in-the-loop is a
  defense against the human's own judgment, not a code-level control.
- **Real RBAC, not a fabricated placeholder** (docs/adr/0130) -
  `updateGovernancePolicy`/`configureAiProvider`, the single most-repeated
  disclosed gap since Phase 5, are now gated by own copies of core's real,
  already-implemented `AccessTokenGuard`/`PermissionsGuard`, adapted for a
  remote-JWKS resource-server role (`jose.createRemoteJWKSet` against
  core's real `/.well-known/jwks.json`) since this is a genuinely separate
  deployable service with no access to core's own token-verification
  database. `assertTokenTenantMatches` closes a problem this cross-service
  split itself introduces: a valid token's own `tenant_id` claim must
  match the request's `x-tenant-id` header. `ai_provider_config`/
  `ai_governance_policy` are registered as real, seeded, grantable
  permissions in core's own role-seeding script - not opaque strings
  nothing can hold.
- **Dashboard**: `observability/grafana-dashboard-module-10.json`, actually
  mounted in `docker-compose.yml` (unlike module-05/06's own dashboards,
  which exist on disk but were never mounted) - panels for every metric
  this module has emitted since Phase 1, plus a disclosed finding made
  while building it: NestJS Guards run before the metrics interceptor, so
  the new RBAC guards' own 401/403s are invisible to every panel.
- 44 new unit tests (156 total) - 6 of which exercise a real, ephemeral
  local JWKS HTTP server and real signed JWTs end to end, not mocks.
  Live-verified: a real JWKS server, a real running instance, and real
  signed JWTs proved all three gated paths (missing token, missing
  permission, tenant mismatch) plus the success path with a real DB write
  and a real `updated_by` UUID taken from the token's own `sub` claim.

## Phase 9 — full gap closure, SCD history, RBAC expansion (docs/adr/0132/0133)

Not one of §9's own numbered phases - a dedicated pass closing every
disclosed gap from Phases 1-8 that's genuinely fixable in code.

- **SCD Type 2 history** for `AiGovernancePolicy`/`AiProviderConfig`
  (`ai_governance_policy_history`/`ai_provider_config_history`) - own copy
  of Module 02's trigger-maintained, append-only pattern (ADR-0009), not
  Module 04's Policy self-versioning flavor, since both tables are
  hot-path-read with history as a secondary audit trail. The provider-config
  table versions on *every* update, not just tracked-column changes - a
  random-IV re-encryption makes "did the key actually change" unobservable
  by comparing columns, and the key itself is never copied into history at
  all. Exposed read-only via `aiGovernancePolicyHistory`/`aiProviderConfigHistory`.
- **RBAC expanded from 2 to 10 gated operations** - `ai_interaction:write`
  for the five `AIInteraction`-generating queries, `ai_recommendation:read`/
  `:write`/`:approve` as three *distinct* permissions for
  `pendingRecommendations`/`createReallocationRecommendation`/
  `decideRecommendation`. A new `TenantTokenMatchGuard` replaces the manual
  per-resolver `assertTokenTenantMatches` call, so a future gated resolver
  can't forget it.
- **Two adversarially-proven hardening fixes to ADR-0131's own disclosed
  findings**: `confidenceIndicator`'s groundedness check now redacts
  untrusted free-text fields (`reason`/`question`) from its own comparison
  baseline - the exact circular-echo exploit ADR-0131 demonstrated no
  longer crosses the threshold it used to. A new suspicious-rationale
  detector forces `requiresHumanApproval: true` on a phrase match ("already
  approved," "no review needed," ...) - closing, not just flagging, the
  socially-engineered-rationale finding.
- **A real, previously-invisible metrics gap fixed**: NestJS Guards run
  before `HttpMetricsInterceptor`, so every RBAC denial since Phase 8 was
  invisible to `/metrics`. `ai_rbac_denials_total` is now recorded directly
  inside the guards themselves.
- **Two real, separate bugs found and fixed**: `observability/prometheus.yml`
  never actually scraped ai-layer-service at all (the Phase 8 dashboard's
  own panels had nothing to read from); this platform's first Prometheus
  alerting rules file now exists, scoped to this module's own
  security-relevant metrics.
- **`OllamaReachabilityChecker`** - a real network probe at
  `configureAiProvider` time (disclosed as configuration-time-only, not a
  standing guarantee), plus a `question` length cap and `baseUrl`
  URL-format validation - two real, previously-missing guardrails.
- **Structural**: `AuthModule` now exists (matching every other concern in
  this service); GraphQL schema `description` metadata added across all
  four core domain types.
- **Investigated and explicitly NOT faked**: a JWT revocation check via
  core's own `/oauth/introspect` - every `OAuthClient` row is tenant-scoped
  with no platform-wide/system client concept, so this cross-tenant backend
  has no way to authenticate to that endpoint on an arbitrary tenant's
  behalf. Needs a schema change to core's own OAuth client model, out of
  this module's own scope - disclosed, not worked around.
- 186 unit tests (up from 175). Extensively live-verified: the SCD
  triggers' exact versioning behavior, every RBAC permission/tenant-mismatch
  scenario with a real DB write on success, the RBAC-denial metric in
  `/metrics` after real denied calls, and Ollama reachability against both
  a real reachable mock server and a real unreachable port.

## Getting started

```bash
# From the platform root - shared Postgres 16 + NATS JetStream, same
# instance every other module uses.
docker-compose up -d
cp .env.example .env
# Generate a real encryption key for BYOK provider credentials:
#   openssl rand -hex 32
# and set AI_PROVIDER_CREDENTIAL_ENCRYPTION_KEY in .env to it.
npm ci
npm run migration:run          # applies src/database/migrations
npm run test                   # unit tests, no DB/NATS required
npm run start:dev              # GraphQL /graphql, /healthz, /readyz, /metrics
```

Once running, configure a tenant's LLM provider before calling
`explainSchedule` for that tenant (otherwise every call degrades
gracefully, `degraded_mode: true`, per §4):

```graphql
mutation {
  configureAiProvider(provider: ANTHROPIC, model: "<see https://docs.claude.com/en/docs_site_map.md for the current model id>", apiKey: "sk-ant-...") {
    provider
    model
    updatedAt
  }
}
```

## Scripts

| Script | What it does |
|---|---|
| `npm run migration:run` / `:revert` | Apply / roll back migrations, using `agno_migrator` credentials (`src/database/data-source.ts`). |
| `npm run test` / `npm run test:integration` | Unit vs. integration Jest suites. |
| `npm run build` / `npm run start:dev` | Standard Nest build/dev bootstrap. |

## Testing strategy

- **Unit** (`test/unit/`): `computeConfidenceIndicator`/`computeGroundedness`
  (§0.5's documented, executable formula); `parseLlmExplanationResponse`
  (well-formed, markdown-fenced, missing-field, and not-JSON-at-all cases —
  never fabricates a summary from an unparseable response);
  `TenantScopeAssertionService` (match, mismatch, first-mismatch-wins,
  metric recording); `AiProviderCredentialCipherService` (round-trip,
  random-IV non-determinism, wrong-key-length rejection, tamper/auth-tag
  detection); `ScheduleExplanationService`'s full orchestration (not-found,
  cross-tenant rejection before any LLM call, happy path with a real
  confidence indicator + write-back + audit call, LLM-failure degraded
  mode, not-configured degraded mode); Phase 3 adds the durable-audit-write
  cases (correct payload on violation, rejection survives an audit-write
  failure); Phase 4 adds `ForecastExplanationService`/
  `ReallocationRationaleService`/`RootCauseAnalysisService`'s own
  orchestration suites (not-found, cross-tenant rejection, happy path,
  degraded mode, plus the "reason" free-text pass-through case and the
  both-sources-empty no-data case); Phase 5 adds governance resolution's
  three-tier order, risk evaluation (pass/fail/fail-closed/partial-config),
  the full recommendation lifecycle including the `suggest_only`
  advisory-only branch, the execution client's success/failure/default-URL
  cases, and the event publisher's best-effort-swallow behavior; Phase 6
  adds `AskQuestionService`'s own suite (source-validation rejection paths,
  correct routing to each of the four `gatherContext` methods, the
  no-fallback-on-LLM-failure behavior, and the explicit human-in-the-loop
  proof that an `nl_query` interaction can never seed an
  `AIRecommendation`); Phase 7 adds `LlmCircuitBreakerService`'s own state
  machine (verified with Jest fake timers, no real sleeps) and
  `ProviderRoutingLlmClient`'s integration of the gate + failure
  classification against real, mocked `@anthropic-ai/sdk`/`openai`
  `APIError` shapes — the first tests in this suite to mock either SDK
  directly; the Gemini/Ollama expansion (docs/adr/0129) adds
  `AiProviderConfigService`'s own validation-rule suite plus
  `ProviderRoutingLlmClient`'s Gemini/Ollama integration, including
  duck-typing Ollama's unexported `ResponseError` shape and a fake-timer-driven
  proof of its manual request-timeout race; Phase 8 adds the adversarial
  prompt-injection suite (structural boundary proofs, parser hardening,
  governance isolation, and the two disclosed findings above) plus
  `test/unit/auth/` — `AccessTokenGuard` verified against a real, ephemeral
  local JWKS HTTP server and real signed JWTs (not mocked), `PermissionsGuard`,
  and `TenantTokenMatchGuard`; Phase 9 adds `AiGovernancePolicyService`/
  `AiProviderConfigService`'s own `getHistory` suites, the confidenceIndicator
  redaction fix (including a direct before/after proof against the exact
  exploit ADR-0131 disclosed), `detectSuspiciousRationalePhrases`'s own
  suite plus the fail-closed override proof, and `OllamaReachabilityChecker`'s
  own suite (mocked `fetch`). 186 tests, all passing, against a fake
  `DataSource`/`EntityManager` (or, for the LLM-client and auth suites,
  mocked SDK modules / a real local HTTP server) — no live Postgres
  required for this suite.
- **Real, live, cross-service integration testing** (Phase 5): unlike
  every prior phase's unit-only verification, Phase 5's centerpiece claim
  (non-negotiable #1's write-back pathway) was proven against a genuinely
  running intraday-service instance and real seeded Postgres rows in this
  session - see `docs/module-10-phase-5-production-readiness-checklist.md`.
  Not (yet) a standing, repeatable `test:integration` suite - this was a
  one-off verification pass, not committed as an automated test file.
- **Not yet applicable**: a standing automated integration test suite
  against real Postgres/NATS/sibling-services (Phase 5's own live pass was
  manual, not committed as a repeatable test), a live call to a real
  Anthropic/OpenAI API (no credentials were available in this build's
  environment — `ProviderRoutingLlmClient`'s two branches are exercised
  only via a mocked `LlmClient` in every service's own tests), load tests,
  chaos/game-day exercises (§0.5's own named scenarios — LLM API
  unreachable, crafted cross-tenant query — both designed and partially
  unit-verified, neither run as a live chaos exercise against a running
  instance), a genuine security/red-team review of §5 (this module's own
  standing pre-launch gate, not something a build phase substitutes for -
  now more urgent given the RBAC gap Phase 5 adds to).

## Documentation index

- `docs/module-10-phase-1-design-doc.md` through
  `docs/module-10-phase-9-design-doc.md` — problem, options, decision,
  consequences, verification, per phase (Phase 9 isn't one of §9's own
  numbered phases - a dedicated full-gap-closure pass, see its own doc).
- `docs/adr/0113`–`0133` — Phase 1/2/3/4/5/6/7/8/9 plus the Gemini/Ollama
  expansion: the schema/RLS shape and why no nullable-tenant-id table is
  needed (0113), the `AIGovernancePolicy` resolution order and `'default'`
  sentinel (0114), the new `ScheduleExplanationDataService` gRPC surface
  added to scheduling-service (0115), the disclosed `generatedByModelId`
  contract mismatch (0116), the deliberate BYOK multi-provider deviation
  from §1's Anthropic-only default (0117), the durable audit trail for
  tenant-scoping violations (0118), the new `ForecastExplanationDataService`
  on forecasting-service (0119), the new `ReallocationService` —
  intraday-service's first-ever gRPC server — (0120), the new
  `AdherenceRollupService` on adherence-compliance-service (0121),
  `rootCauseAnalysis`'s two-module scope decision plus the
  `ListReallocationsForPeriod` cap (0122), the `suggest_only` vs.
  `approve_required` execution split (0123), the write-back execution
  pathway + real risk criteria (0124), the nullable-column/RBAC-gap
  disclosures (0125), the `gatherContext` extraction once `askQuestion`
  became a real second caller (0126), `askQuestion`'s
  caller-supplied-resource-pointer design plus its no-fallback-on-failure
  contract (0127), the LLM circuit breaker's per-provider (not per-tenant)
  keying plus its classified-failures design (0128), Gemini/Ollama's
  addition as BYOK providers — the self-hosted `baseUrl` requirement and
  nullable-key design (0129), real RBAC via a remote-JWKS copy of core's
  own guards rather than a fabricated placeholder (0130), the
  prompt-injection blast-radius findings — the confidenceIndicator
  inflation path and the unfiltered rationaleText passthrough (0131, both
  **closed in Phase 9**), SCD Type 2 history for governance policy/provider
  config matching Module 02's own precedent (0132), and Phase 9's own full
  gap-closure pass — RBAC expansion, the RBAC-denial metrics fix, and the
  Ollama reachability check (0133).
- `docs/module-10-phase-1-production-readiness-checklist.md` through
  `-phase-9-production-readiness-checklist.md` — what's done vs. genuinely
  out of scope, per phase, including two disclosed environment gaps
  (core's gRPC server on port 5000, confirmed unreachable both as
  REST/HTTP2 and by direct gRPC probe; and a real, pre-existing
  graceful-shutdown bug found in intraday-service, unrelated to this
  module's own changes), one disclosed, deliberate scope limitation
  (`rootCauseAnalysis`'s reallocation source is tenant-wide, not
  org-unit-filtered), the RBAC gap on `updateGovernancePolicy`/
  `configureAiProvider` (Phase 5's own most consequential disclosed item,
  closed in Phase 8 — ADR-0130 — then **expanded to the full schema in
  Phase 9** — ADR-0133), Phase 7's own disclosed gap that the circuit
  breaker's state is in-memory/per-process only, with no distributed store
  for a future multi-replica deployment, the Gemini/Ollama expansion's own
  disclosed gap that this platform never validates or tunnels to a
  tenant's self-hosted Ollama instance (**a real, configuration-time-only
  reachability check added in Phase 9**), and Phase 9's own remaining
  disclosed gaps: a JWT revocation check remains genuinely infeasible
  without a schema change to core's own OAuth client model (investigated,
  not faked), and the real security/red-team review of §5 itself is still
  outstanding.
