# Module 09 Phase 7 Design Doc — Analytics & Reporting: Natural-Language Query Bridge

**Status:** Approved for implementation
**Owner:** Analytics & Reporting pod (Module 09).
**Scope:** §8's own Phase 7 line: "NL query bridge to Module 10 (if available)." §4.1/§5's `askAnalyticsQuestion` mutation.

## Problem

"If available" needed to be checked against the actual repository, not assumed either way. A repo-wide grep for any `module-10`/`nl-query`/natural-language-service directory, package, ADR, or docker-compose entry turned up nothing - **Module 10 does not exist anywhere in this platform.** This is the same situation Module 04 already hit and disclosed for one of its own external dependencies (confirmed by reading that module's own ADR trail, not assumed from memory): the honest move precedented there is to build the real contract and orchestration on this module's side, wire it to a client implementation that is explicit about being unavailable, and disclose the gap loudly rather than stub the whole feature out or silently skip it. ADR-0111 records this.

The design question that follows: what should the *shape* of the bridge be, given the other side doesn't exist to negotiate a real contract with? Two things are already fixed and don't need inventing:
- **What "answering a question" decomposes into.** Every other read path in this module already goes through `MetricQueryEngineService` (`query`/`executiveSummary`) - a natural-language question can only ever resolve to one of those two calls plus a filter, never a third bespoke query path. Inventing a separate "answer engine" that reads data on its own would duplicate the whitelist/RLS/replica-read discipline `MetricQueryEngineService` already enforces, for no reason.
- **What Module 10 would actually be asked to do.** Two things, and only two: turn English into one of those two structured calls (`translateQuestion`), and turn the resulting rows into an English sentence (`generateAnswer`). Nothing else crosses the boundary - this module never sends Module 10 raw tenant data beyond the one already-filtered result set it needs to describe, and never lets Module 10 pick a table or column that bypasses `SOURCE_VIEW_REGISTRY`.

## Decision

**`NlQueryBridgeClient`** (interface, `src/analytics/nl-query-bridge/nl-query-bridge-client.ts`): two methods, `translateQuestion(tenantId, question): Promise<StructuredAnalyticsQuery>` and `generateAnswer(tenantId, question, results): Promise<string>`. `StructuredAnalyticsQuery` is a discriminated union of exactly the two shapes `MetricQueryEngineService` already accepts (`{kind: 'metricQuery', metricName, filter?}` / `{kind: 'executiveSummary', orgUnitId?, period}`) - not a generic "query object" that would need its own new validation/whitelist layer.

**`AskAnalyticsQuestionService.ask(tenantId, question)`**: calls `translateQuestion`, dispatches the result to `MetricQueryEngineService.query` or `.executiveSummary` based on `kind`, passes the resulting rows to `generateAnswer`, and returns `{question, answerText, results}`. This orchestration is real and independently correct - proven by its own unit tests against a mock bridge client that simulates a working Module 10, so this half of the contract is verified without needing the other side to exist.

**`NotAvailableNlQueryBridgeClient`**: the only `NlQueryBridgeClient` registered in `AnalyticsModule` today. Both methods unconditionally throw `NlQueryBridgeUnavailableError` (`NL_QUERY_BRIDGE_UNAVAILABLE`, mapped to `503 Service Unavailable` in `DomainErrorFilter`). Swapping in a real client once Module 10 ships is a one-line change to `AnalyticsModule`'s provider registration - no change to `AskAnalyticsQuestionService`, the resolver, or the GraphQL schema.

**`askAnalyticsQuestion(question: String!): AnalyticsAnswer!`** (GraphQL mutation, tenant-scoped like every other query in this module, no actor identity needed - same reasoning Phase 4 used for `metricQuery`/`executiveSummary`). `AnalyticsAnswer` returns `question` (echoes input), `answerText`, and `results: [MetricResult!]!` - the identical `MetricResult` shape `metricQuery` already returns, never a third, bespoke result shape.

## Blast radius

- New: `NlQueryBridgeClient` interface + `NL_QUERY_BRIDGE_CLIENT` DI token, `NotAvailableNlQueryBridgeClient`, `AskAnalyticsQuestionService`, `NlQueryBridgeUnavailableError`, `AnalyticsAnswerResult`/`toAnalyticsAnswerResult`, one new GraphQL mutation, one new `DomainErrorFilter` entry.
- Zero schema/migration changes - this phase reads and writes nothing new to Postgres. No new table, no new entity.
- Zero modification to `MetricQueryEngineService`'s own code - `AskAnalyticsQuestionService` calls its existing public `query`/`executiveSummary` methods unchanged.
- Zero modification to any Module 01–08 table, migration, schema, or running code.
- `docker-compose.yml`: no change - there is no Module 10 service to add, and this phase deliberately doesn't stand up a fake one.

## Rollback plan

Revert `AnalyticsModule`'s `NL_QUERY_BRIDGE_CLIENT` provider and `AskAnalyticsQuestionService`, remove the `askAnalyticsQuestion` mutation from `MetricResolver`, revert `DomainErrorFilter`'s one new entry, delete the `nl-query-bridge/` directory and `ask-analytics-question.service.ts`, remove this doc and its checklist. Nothing outside this service depends on this phase's surface - no migration to revert, since none was written.

Verified live against a real running instance (not just unit tests): booted the app, called `askAnalyticsQuestion(question: "How is adherence trending?")` via a real GraphQL request, and confirmed it correctly returns a typed `NL_QUERY_BRIDGE_UNAVAILABLE` error (503) rather than a 500 or a silent empty answer - proving the resolver, service, DI wiring, and error-filter mapping are all real and correctly connected end to end, even though the answer itself is always "unavailable" until Module 10 exists. `AskAnalyticsQuestionService`'s own orchestration logic (translate → dispatch to the correct query-engine method → generate answer → shape the result; and that a failure at any step short-circuits the rest without calling `generateAnswer`) is proven separately against a mock `NlQueryBridgeClient` that simulates a working Module 10, since the real implementation can only ever demonstrate the unavailable path. 136 unit tests pass (up from 129 in Phase 6, 7 new), lint/typecheck/build clean.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Module 10 does not exist in this platform**, confirmed by repo-wide grep, not assumed either way - see ADR-0111.
2. **`StructuredAnalyticsQuery` is a closed union of the two shapes `MetricQueryEngineService` already accepts**, not an open-ended query object - keeps every existing whitelist/RLS/security guarantee intact regardless of what Module 10 eventually sends.
3. **The mutation needs no actor identity** - same reasoning as `metricQuery`/`executiveSummary` (Phase 4): a read-only, tenant-scoped question has no per-actor ownership concept.
4. **No caching of questions/answers** - every call re-runs `translateQuestion`/`generateAnswer`/the underlying query fresh. Not a real cost concern today since every call fails immediately with `NL_QUERY_BRIDGE_UNAVAILABLE` before reaching either query method.
5. **This is a one-shot request/response mutation, not a subscription or streaming answer** - §5 describes a single question/answer exchange, nothing suggesting a conversational or streaming UX.

## Out of scope for this phase (do not build yet)

- **A real Module 10 implementation of `NlQueryBridgeClient`.** Module 10 does not exist; building a real LLM-backed translator/answer-generator here would be building Module 10 itself, not Module 09's bridge to it.
- **The consistency-check job and load testing.** Phase 8.
