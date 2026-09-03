# Module 09 Phase 7 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is genuinely out of reach until Module 10 exists. **The single most important line in this checklist: the `askAnalyticsQuestion` mutation is real, correctly wired end-to-end, and live-verified - but every real call to it fails with `NL_QUERY_BRIDGE_UNAVAILABLE`, because Module 10 does not exist anywhere in this platform yet (ADR-0111).** This phase built the bridge and proved Module 09's own half of it works; it did not, and could not, build the other side.

## Delivered in this phase (application code)

- [x] `NlQueryBridgeClient` interface (`translateQuestion`/`generateAnswer`) - a closed contract, not an open-ended one, restricted to the two structured-query shapes `MetricQueryEngineService` already accepts (`metricQuery`/`executiveSummary`), so nothing Module 10 eventually sends can bypass `SOURCE_VIEW_REGISTRY`'s whitelist or this module's RLS/replica-read discipline.
- [x] `AskAnalyticsQuestionService.ask` - real orchestration: translate → dispatch to the correct existing `MetricQueryEngineService` method → generate answer → return `{question, answerText, results}`. Zero duplication of query logic; reuses `query()`/`executiveSummary()` unchanged.
- [x] `NotAvailableNlQueryBridgeClient` - the only registered implementation. Both methods unconditionally throw `NlQueryBridgeUnavailableError` (`NL_QUERY_BRIDGE_UNAVAILABLE`, 503). Swapping in a real client is a one-line provider change in `AnalyticsModule`, no other code changes.
- [x] `askAnalyticsQuestion(question: String!): AnalyticsAnswer!` GraphQL mutation, tenant-scoped, wired into `MetricResolver`. `AnalyticsAnswer.results` reuses the exact same `MetricResult` shape `metricQuery` returns.
- [x] `NlQueryBridgeUnavailableError` registered in `DomainErrorFilter` (503, both REST and GraphQL error paths).
- [x] Unit test coverage: `AskAnalyticsQuestionService` tested against a **mock** `NlQueryBridgeClient` that simulates a working Module 10 - proves dispatch-to-`query()`, dispatch-to-`executiveSummary()`, correct short-circuiting on a `translateQuestion` failure (never calls the query engine or `generateAnswer`), and correct short-circuiting on a query-engine failure (never calls `generateAnswer`). `NotAvailableNlQueryBridgeClient` tested directly for both methods throwing, including the error's `code` property. 136 tests total (up from 129 in Phase 6, 7 new), all passing.
- [x] Verified live against a real running instance: booted the app, sent a real GraphQL `askAnalyticsQuestion` request, confirmed it returns the correctly-typed `NL_QUERY_BRIDGE_UNAVAILABLE` error (503) - proving resolver → service → DI-injected client → error filter are genuinely wired end to end, not just unit-tested in isolation.

## Explicitly NOT done here (needs Module 10 to exist, or is a disclosed gap)

- [ ] **Every real call to `askAnalyticsQuestion` fails.** There is no working natural-language answer today, and cannot be until Module 10 ships. This is the honest headline of this phase, not a footnote.
- [ ] **No real `translateQuestion`/`generateAnswer` implementation exists or was attempted.** Building one here would mean building Module 10 itself (an LLM-backed translator/answer-generator), which is out of this module's scope regardless of how this bridge is shaped.
- [ ] **No caching of questions/answers.** Not a real concern today since every call fails before reaching a cacheable step; revisit once a real client exists and cost/latency become real considerations.
- [ ] **The consistency-check job.** Still not built. Phase 8.
- [ ] **Load testing.** Still not done. Phase 8.
