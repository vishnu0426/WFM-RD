# ADR-0126: extracting `gatherContext` from all four explanation/analysis services — generalizing once `askQuestion` became a real second caller

## Context
§9 Phase 6 asks for `askQuestion`, an NL-query interaction type that answers a free-text question grounded in the same real structured data the four existing interaction types (`explainSchedule`, `explainForecast`, `explainReallocation`, `rootCauseAnalysis`) already retrieve, tenant-scope-assert, and shape. Building `askQuestion` a fifth independent fetch-path would duplicate the gRPC-retrieve + §5.1 assertion + shaping logic a fifth time, and would risk the two copies drifting (e.g. one gets a schema/field change the other doesn't).

This mirrors the exact posture Phase 4 already took for `parseLlmExplanationResponse` (docs/adr/0119 area): keep the logic private and inlined while there is only one caller, extract it once a second real caller exists - not before, on the theory that a premature abstraction guessed at the wrong seam is worse than brief duplication.

## Decision
- Each of the four existing services (`ScheduleExplanationService`, `ForecastExplanationService`, `ReallocationRationaleService`, `RootCauseAnalysisService`) now exposes a public `gatherContext(tenantId, ...)` method containing exactly the gRPC-retrieve + `TenantScopeAssertionService.assertSameTenant` + data-shaping steps that previously lived inline at the top of `explainSchedule`/`explainForecast`/`explainReallocation`/`analyzeRootCause`.
- Each of those four top-level methods is now a thin wrapper: call its own `gatherContext`, then run the (unchanged) shared LLM-call/persist/audit/write-back pipeline against the result.
- No behavior changed for any of the four existing interaction types - this is a pure extraction. All 72 pre-existing unit tests (18 per service × 4, ADR-0122's own count of "42 unit tests" plus Phase 5's later additions) passed unchanged both before and after the refactor, confirmed via `npm test` and `npm run build` immediately after all four extractions landed.
- `AskQuestionService` (docs/adr/0127) is the second real caller of each `gatherContext` - it calls whichever one of the four matches the caller-supplied `AskQuestionContext`, never re-implementing any of their internals.

## Consequences
- A future schema/field change to any one owning module's gRPC contract only needs to be reflected in that one service's `gatherContext` - both its own top-level explanation method and `AskQuestionService` see the update automatically, with no risk of the two drifting.
- Each `gatherContext` method's own doc comment now names Phase 6/this ADR as the reason for its existence, matching the convention `parseLlmExplanationResponse`'s own doc comment already established.
- This ADR intentionally does not generalize further (e.g. a shared base class or a single parameterized `gatherContext(sourceType, id)` dispatcher) - four small, independently readable methods, each owned by the service that already owns the underlying gRPC client, was judged clearer than one dispatcher that would need to know about all four owning modules at once. `AskQuestionService`'s own `resolveSource` is that dispatch logic, kept at the one call site that actually needs it.
