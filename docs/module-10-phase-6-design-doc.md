# Module 10 Phase 6 Design Doc — AI Layer: `askQuestion` NL Query & Human-in-the-Loop Confirmation

**Status:** Approved for implementation
**Owner:** AI Layer pod.
**Scope:** §9's own Phase 6 line: "NL query / conversational interface. `askQuestion`, with the human-in-the-loop confirmation requirement from the source spec's UI concept built in from the start."

## Problem

Two real ambiguities needed resolving before this phase's code could be written:

1. **How does a free-text question get resolved to real data?** §9's own phrase "conversational interface" reads as free-text in, free-text out - implying the platform can infer which schedule/forecast/reallocation/org unit a question is about. No such capability exists anywhere in this platform (ADR-0111 already disclosed the identical gap for Module 09's `NlQueryBridgeClient`). Resolved in ADR-0127: the caller supplies an explicit, unambiguous resource pointer (`AskQuestionContextInput` - exactly one of `scheduleJobId`, `forecastRunId`, `reallocationActionId`, or `orgUnitId`+`periodStart`+`periodEnd` together); this module never guesses.
2. **What happens on LLM failure, given NL query has no non-LLM equivalent?** Every prior interaction type falls back to returning its own raw retrieved data under §4. Raw grounding data is not itself an answer to an NL question. Resolved in ADR-0127: the attempt is still persisted (`degradedMode: true`, audited), but the caller receives an explicit `AiAssistantUnavailableError` ("AI assistant is temporarily unavailable — try the dashboard directly") rather than a hollow "successful" response.

A necessary precursor (ADR-0126): the four existing interaction-type services each needed a reusable `gatherContext` method, extracted once `AskQuestionService` became a real second caller of each - the same "generalize once there's a second caller" posture Phase 4 already used for `parseLlmExplanationResponse`.

## Decisions

- **`gatherContext(tenantId, ...)` extracted on all four existing services** (`ScheduleExplanationService`, `ForecastExplanationService`, `ReallocationRationaleService`, `RootCauseAnalysisService`) - a pure refactor, no behavior change, all 72 pre-existing tests passing unchanged before and after.
- **`AskQuestionService.resolveSource`** enforces "exactly one resource pointer" as an explicit runtime check (`AskQuestionContextInvalidError`, 400) - not attempted at the GraphQL schema level, since GraphQL's own type system has no mutually-exclusive-fields construct for four optional scalars.
- **`nl-query-prompt.ts`** treats the entire `question` field as untrusted content (§5.2), labeling the two blocks of the user message explicitly (`GROUNDING DATA` vs. `USER QUESTION`) rather than relying on message-role separation alone - the first interaction type where the *entire* input, not a sub-field, is tenant-user-authored free text.
- **Human-in-the-loop is structural, not an added runtime check**: `AiRecommendationService.createFromInteraction` only accepts `reallocation_rationale`-typed interactions (Phase 5); `askQuestion` always produces an `nl_query`-typed one. An `nl_query` interaction can never seed an `AIRecommendation` - proved directly in `ask-question.service.spec.ts` by feeding a real `askQuestion` output into `createFromInteraction` and asserting the rejection. The system prompt's own "never present your answer as if the action already happened" instruction reinforces this in the model's own language, but the actual guarantee lives in the type check, not the prompt.
- **No fallback to raw data on LLM failure** - the one deliberate departure from every prior interaction type's §4 behavior, justified above and in ADR-0127.
- Kept a GraphQL `Query`, matching `explainSchedule`/`explainForecast`/`explainReallocation`/`rootCauseAnalysis` (all four also persist a new row despite being read operations from the caller's perspective).

## Consequences / Verification

- 8 new unit tests (`ask-question.service.spec.ts`): both context-validation rejection paths (zero sources, more than one source, partial root-cause fields), correct routing to each of the four `gatherContext` methods, the happy path, the no-fallback-on-LLM-failure behavior (row persisted degraded, error still thrown), an untouched-passthrough of a non-LLM error from a `gatherContext` call, and the explicit human-in-the-loop proof.
- 80 unit tests total (up from 72), all passing; `npm run typecheck`/`build`/`lint` all clean.
- Live boot verification against the same running Postgres instance used in prior phases: full dependency graph (now including `AskQuestionService`) resolved correctly; `src/schema.gql` inspected directly and confirmed (`askQuestion(context: AskQuestionContextInput!, question: String!): AIInteraction!`); four live GraphQL calls exercised against the running instance - missing tenant header (`TENANT_CONTEXT_MISSING`), zero sources (`ASK_QUESTION_CONTEXT_INVALID`), two sources (`ASK_QUESTION_CONTEXT_INVALID`), and one valid source with scheduling-service intentionally not running (correctly surfaced `SCHEDULING_SERVICE_UNAVAILABLE` from the reused `gatherContext` path, not masked as a different error).
- No live LLM call was made this phase either (same disclosed posture as every prior phase) - `askQuestion`'s LLM-call and degraded-mode branches are proven via mocked `LlmClient`/`AiProviderConfigService` in the unit suite, same as all four prior interaction types.
- What's next: Phase 7 (the full circuit breaker), Phase 8 (prompt-injection test suite - now with `askQuestion`'s all-free-text input as its most important target, dashboards, the real security review, which still needs to close the `updateGovernancePolicy`/`configureAiProvider` RBAC gap named in every prior phase's own checklist).
