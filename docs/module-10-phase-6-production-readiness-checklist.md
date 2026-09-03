# Module 10 Phase 6 Production Readiness Checklist

**The single most important line in this checklist**: the human-in-the-loop guarantee §9 Phase 6 calls out is **structural**, not a runtime check that could be forgotten in a future change - `AiRecommendationService.createFromInteraction` only ever accepts a `reallocation_rationale`-typed interaction, and `askQuestion` always produces an `nl_query`-typed one. This was proved directly, not just asserted, in `ask-question.service.spec.ts`.

## Delivered in this phase (application code)

- [x] `gatherContext` extracted on all four existing interaction-type services (`ScheduleExplanationService`, `ForecastExplanationService`, `ReallocationRationaleService`, `RootCauseAnalysisService`) - docs/adr/0126, pure refactor, zero behavior change.
- [x] `AskQuestionService` - resolves exactly one caller-supplied resource pointer to its matching `gatherContext` call, builds the NL-query prompt, calls the LLM, persists an `nl_query`-typed `AIInteraction`, audits, and either returns the answer or throws `AiAssistantUnavailableError` on LLM failure (no raw-data fallback, unlike every prior interaction type - docs/adr/0127).
- [x] `nl-query-prompt.ts` - the untrusted-content boundary applied to an entire free-text field for the first time (§5.2), not just a sub-field.
- [x] `AskQuestionContextInput` GraphQL input type + `AskQuestionContextInvalidError` (400) for the "exactly one source" validation.
- [x] `AiAssistantUnavailableError` (503) - the NL-query-specific degraded-mode contract.
- [x] GraphQL: `askQuestion(context, question)` - the last §6.1 operation this module had not yet built.
- [x] 8 new unit tests, 80 total (up from 72), all passing.

## Explicitly NOT done here (later phases, named in §9)

- [ ] The full circuit breaker (Phase 7) - `AskQuestionService` inherits the same minimal-but-real degraded-mode posture every prior phase's services use (with the one NL-query-specific deviation: no raw-data fallback, since none exists).
- [ ] Prompt-injection test suite (Phase 8) - `askQuestion` is now this module's highest-priority target for that suite, since it is the first interaction type whose entire input (not a sub-field) is tenant-user-authored free text. Nothing beyond the system prompt's own instructions defends against injection in this phase.
- [ ] NL entity resolution (turning "why was Maria's shift moved" into a `reallocationActionId`) - explicitly out of scope, per ADR-0127's own reasoning (same posture ADR-0111 already took for Module 09). `askQuestion` requires an explicit resource pointer; it does not, and cannot yet, infer one.

## Verification performed

- [x] `npm run typecheck` / `npm run build` / `npm run lint` / `npm test` (80/80) on ai-layer-service - clean.
- [x] Full app re-boot (`node dist/src/main.js`) against the same running Postgres instance used in prior phases; full dependency graph, now including `AskQuestionService`, resolved correctly; `src/schema.gql` inspected directly and confirmed correct.
- [x] Four live GraphQL calls against the running instance, each producing the exact expected error/behavior:
  1. No `x-tenant-id` header → `TENANT_CONTEXT_MISSING`.
  2. Empty `context: {}` → `ASK_QUESTION_CONTEXT_INVALID` ("received 0 candidate sources").
  3. Two sources set (`scheduleJobId` + `forecastRunId`) → `ASK_QUESTION_CONTEXT_INVALID` ("received 2 candidate sources").
  4. One valid source (`scheduleJobId`) with scheduling-service intentionally not running → `SCHEDULING_SERVICE_UNAVAILABLE`, proving `AskQuestionService` correctly delegates to `ScheduleExplanationService.gatherContext` and its real error surfaces untouched, not masked as a generic failure.
- [x] Regression check: all 72 pre-existing tests across the four refactored services still pass unchanged after the `gatherContext` extraction, confirmed both immediately after the refactor and again after `AskQuestionService` was built on top of it.

## Honestly disclosed gaps (not glossed over)

- [ ] **No live LLM call was made this phase** - same disclosed posture as every prior phase (Phases 2, 4, 5). `askQuestion`'s LLM-call and degraded-mode branches are proven via a mocked `LlmClient`/`AiProviderConfigService` in the unit suite only.
- [ ] **`askQuestion` has no RBAC gate**, same standing gap as every other mutation/query in this module (ADR-0117/0125's own disclosure) - any tenant-authenticated caller can ask any question about any resource pointer within their own tenant. Read-only in effect (never mutates anything), so lower urgency than `updateGovernancePolicy`/`configureAiProvider`, but not zero: a tenant user could probe for information a stricter role-based view might otherwise withhold.
- [ ] **No prompt-injection test suite exists yet** (explicitly deferred to Phase 8) - `askQuestion`'s system prompt states the anti-injection rule in `nl-query-prompt.ts`, but no adversarial test has actually tried to defeat it. This is now the single most important item in Phase 8's own scope, more so than for any prior interaction type, since `question` is the first fully-free-text input this module accepts.
- [ ] Load testing, chaos/game-day exercises, a real security/red-team review of §5 - none run this phase, same standing gap named in every prior phase's own checklist.
