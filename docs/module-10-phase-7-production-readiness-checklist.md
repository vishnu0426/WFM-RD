# Module 10 Phase 7 Production Readiness Checklist

**The single most important line in this checklist**: the circuit breaker is keyed by **provider**, not tenant, and only counts **classified, provider-side failures** toward opening - a tenant's own bad API key can never open a shared circuit that then degrades every other tenant on the same provider. This distinction was the entire point of Phase 7's own design work (ADR-0128), not an afterthought.

## Delivered in this phase (application code)

- [x] `LlmCircuitBreakerService` - per-provider state machine (`closed`/`open`/`half_open`), 5-consecutive-countable-failures threshold, 30s cooldown, exactly-one-trial-call half-open semantics.
- [x] `ProviderRoutingLlmClient` - gates every call through the breaker before any network attempt; classifies each failure (tenant-specific auth/bad-request vs. provider-side) before recording it; short-circuits into the same `LlmCallFailedError` every existing service already handles.
- [x] Fixed a real, pre-existing bug: `LlmCallFailedError`'s message hardcoded "Anthropic" regardless of the actual failing provider - now correctly attributed, backward-compatible with every pre-existing direct construction in the test suite.
- [x] `MetricsService` - `ai_llm_api_calls_total` gains a `short_circuited` result value and corrected (no-longer-Anthropic-only) help text; `ai_circuit_breaker_state_transitions_total` (declared since Phase 1, unwired until now) is a real, observed metric.
- [x] 17 new unit tests, 97 total (up from 80), all passing - including the first tests in this module's suite to mock the real `@anthropic-ai/sdk`/`openai` packages directly.

## Explicitly NOT done here (later phases, named in §9)

- [ ] Prompt-injection test suite (Phase 8) - unrelated to this phase's own scope, still fully outstanding.
- [ ] Dashboards for the newly-wired circuit breaker/degraded-mode metrics (Phase 8's own named scope) - the metrics are real and observed as of this phase, but no Grafana board or alert rule consumes them yet.
- [ ] A shared/distributed circuit-breaker state store for a future multi-replica deployment - this phase's breaker is in-memory, per-process; a second running instance of this service would have its own, independent circuit state. Not relevant to this build's current single-instance-per-service posture, but a real limitation for whenever that changes.

## Verification performed

- [x] `npm run typecheck` / `npm run build` / `npm run lint` / `npm test` (97/97) on ai-layer-service - clean.
- [x] Full app re-boot (`node dist/src/main.js`) against the same running Postgres instance used in every prior phase; `LlmCircuitBreakerService` resolved correctly in the full dependency graph.
- [x] `/metrics` inspected directly on the running instance and confirmed: `ai_llm_api_calls_total`'s HELP line correctly reads "LLM API call outcomes across both BYOK providers (success/error/timeout/short_circuited)" (previously "Anthropic API call outcomes"), and `ai_circuit_breaker_state_transitions_total` is present and registered.
- [x] `LlmCircuitBreakerService`'s state machine verified in full isolation with Jest fake timers (no real sleeps): closed→open at exactly the 5th consecutive countable failure, remains open through the cooldown window minus one millisecond, transitions to half-open at exactly the cooldown boundary, a concurrent second call during an in-flight half-open trial is correctly still short-circuited, a successful trial closes the circuit, a failed trial reopens it and restarts (not continues) the cooldown, and non-countable (401) failures never move the circuit no matter how many accumulate.
- [x] `ProviderRoutingLlmClient` verified against real, mocked `@anthropic-ai/sdk`/`openai` `APIError` instances (constructed via prototype assignment, not the real constructors, to avoid needing to match each SDK's own internal constructor signature): a 500 counts and eventually opens the circuit; a 401 never does even after 10 consecutive occurrences; a 408 records the `timeout` metric specifically; an open circuit's 6th call never invokes the mocked SDK method at all (proving the short-circuit genuinely skips the network, not just re-labels the outcome); and the provider-attribution fix is proven directly (an OpenAI failure's message reads "OpenAI API call failed...", not "Anthropic").

## Honestly disclosed gaps (not glossed over)

- [ ] **No live LLM provider outage was observed in this session** - same disclosed posture as every prior phase regarding live LLM calls generally. The breaker's real-world behavior against a genuinely failing Anthropic/OpenAI API (as opposed to a mocked SDK error) is unverified in production conditions.
- [ ] **In-memory, per-process circuit state** - disclosed above under "explicitly not done." Acceptable for this build's current single-instance posture; would need real attention (a shared store) before a multi-replica deployment of this service.
- [ ] The classification list (400/401/403/404/422 as tenant-specific) is a judgment call, not something either provider's own API documentation prescribes as "safe to exclude from outage detection" - a 404 from a bad model id and a 404 from a genuinely broken routing rule would look identical to this classifier. Disclosed as a real, if narrow, misclassification risk rather than treated as airtight.
- [ ] Load testing, chaos/game-day exercises (this phase's own breaker behavior under real concurrent load and a real simulated outage would be the natural next exercise), a real security/red-team review of §5, and the still-open `updateGovernancePolicy`/`configureAiProvider` RBAC gap (ADR-0125, standing since Phase 5) - none addressed this phase, same standing gaps named in every prior phase's own checklist.
