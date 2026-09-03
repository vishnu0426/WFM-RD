# ADR-0111: the NL query bridge ships as a real, typed contract this module is ready to call — Module 10 does not exist anywhere in this codebase, confirmed by inspection, so no network call to it can honestly be built

## Context
§4.1/§5/§8 Phase 7 describe `askAnalyticsQuestion` as a bridge: "natural language → structured `metricQuery`/`executiveSummary` call → answer; Module 09 owns the query execution, Module 10 owns the NL translation and response generation, same clean boundary as Module 04↔Module 10 for schedule explanations." Building this phase required first checking what "Module 04↔Module 10" actually is in this codebase, not assuming it names a real, callable service.

**It does not.** Confirmed by inspection, not assumed:
- No `nl-service`/`assistant-service`/`explanation-service`/`module-10-*` directory exists anywhere in this repo.
- `docker-compose.yml` has no service for it.
- No ADR (0001–0110) mentions "Module 10" anywhere in its text.
- Module 04's own design doc says so explicitly: *"`explanation` stays `null` until something (**Module 10, not built in this repo**) actually subscribes and calls back"* (`docs/module-04-phase-6-design-doc.md`).
- Module 04's actual integration is a NATS event publish (`agno.scheduling.job.completed.v1`) plus an inbound webhook (`POST /v1/scheduling/jobs/{jobId}/explanation`) that nothing in this repo has ever called - no outbound client, no LLM SDK usage, no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-shaped config anywhere in the codebase (repo-wide `grep`, zero hits).
- This module's own Phase 1 checklist already said as much, before this phase existed to act on it: *"No code in this service calls or is called by Module 10."*

So "same clean boundary as Module 04↔Module 10" is, on inspection, a boundary with nothing real on the far side in either direction - Module 04 publishes into a void; this module's spec asks it to call into the same void. The question this phase actually has to answer is not "how do we call Module 10" (there is nothing to call) but "what is the honest, useful thing to build given that."

Three options were considered:

1. **Build nothing** - leave `askAnalyticsQuestion` entirely unbuilt, same as Phase 1–6 left it. Rejected: this phase's own name is "NL query bridge to Module 10" - building literally nothing would make this phase a no-op, and it leaves Module 09's own half of the contract (translate → execute → answer) unproven even once Module 10 eventually exists.
2. **Fabricate a working integration** - hardcode a fake "translation" (e.g., keyword-matching a question to a metric name) and call it the NL bridge. Rejected outright: this is exactly the "don't fabricate a result to fill a confirmed gap" failure mode ADR-0098/0109/0110 already named and rejected for other gaps in this module's own build. A keyword-matcher is not natural-language understanding, and presenting it as `askAnalyticsQuestion`'s real behavior would be worse than not building the feature at all.
3. **Build a real, typed contract (an injectable client interface) that this module is fully ready to call, wired today to the only honest implementation available: one that says "not available yet."** This ADR adopts this option.

## Decision
`NlQueryBridgeClient` is a real TypeScript interface with two methods matching §4.1's own described flow:
- `translateQuestion(tenantId, question): Promise<StructuredAnalyticsQuery>` - Module 10's job: NL → a structured `metricQuery`/`executiveSummary`-shaped request.
- `generateAnswer(tenantId, question, results): Promise<string>` - Module 10's job: structured results → a natural-language answer.

`AskAnalyticsQuestionService.ask(tenantId, question)` orchestrates the full flow this phase's own name describes: call `translateQuestion`, execute the structured query via the **existing** `MetricQueryEngineService.query`/`executiveSummary` (never a new, parallel query path - this module still owns execution, exactly as specified), call `generateAnswer` with the real results, return `{ question, answerText, results }`. This orchestration is real code, fully unit-tested against a mock `NlQueryBridgeClient` that simulates a working Module 10 - proving Module 09's own half of the contract is correct and ready, independent of whether Module 10 exists yet.

**The only `NlQueryBridgeClient` implementation wired into the running app today is `NotAvailableNlQueryBridgeClient`**, which throws a typed `NlQueryBridgeUnavailableError` from both methods - an honest, immediate, typed failure (mapped to `503 Service Unavailable` over REST, a normal GraphQL error over that transport), never a fabricated answer and never a silent no-op. `askAnalyticsQuestion` is a real, callable GraphQL mutation - it fails honestly, on every call, until a real `NlQueryBridgeClient` is registered in `AnalyticsGraphQLModule`'s providers (a one-line swap, by design - the same "provider interface, swappable implementation" shape NestJS DI already gives every other injected dependency in this codebase).

## Consequences
- `askAnalyticsQuestion` exists, is schema-visible, and is spec-compliant in shape - but every real call to it fails with `NL_QUERY_BRIDGE_UNAVAILABLE` until a real Module 10 (or a real LLM integration standing in for it) exists somewhere in this platform. This is not a Module-09-specific shortcoming to fix in a later phase of *this* module - Module 10 not existing is a platform-wide gap, the identical one Module 04 already carries for schedule explanations, not something Phase 8 or any later Module 09 phase can close on its own.
- The moment a real Module 10 (or equivalent LLM-backed service) exists, wiring it in is exactly one `AnalyticsGraphQLModule` provider registration - no change to `AskAnalyticsQuestionService`, the resolver, the GraphQL schema, or any test that already exercises the orchestration against a mock client.
- `docs/module-09-phase-7-production-readiness-checklist.md` states this explicitly and prominently - "the mutation works; the answer it gives is always `NL_QUERY_BRIDGE_UNAVAILABLE`" is the honest one-line summary of this phase's actual production readiness, not something to bury under "askAnalyticsQuestion: done."
- If Module 10 is built in a future session, that work should register a real `NlQueryBridgeClient` implementation (an HTTP/gRPC client, most likely) against this same interface - not redesign the interface, unless real Module 10 API contracts turn out to need a different shape than this ADR guessed at (in which case that mismatch is exactly the kind of thing to revisit with its own ADR then, not now).
