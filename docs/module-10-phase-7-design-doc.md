# Module 10 Phase 7 Design Doc — AI Layer: the Full LLM Circuit Breaker

**Status:** Approved for implementation
**Owner:** AI Layer pod.
**Scope:** §9's own Phase 7 line: "the full circuit breaker" - every prior phase ran with a real but minimal per-call degraded-mode catch instead (§4), disclosed as a standing gap in every readiness checklist since Phase 2.

## Problem

Two real design questions needed resolving before this phase's code could be written:

1. **Keyed by what, in a multi-tenant BYOK platform?** (docs/adr/0117) A per-tenant breaker means every tenant independently rediscovers the same provider-wide outage; a single global breaker across both providers would incorrectly degrade tenants on the *unaffected* provider during a one-provider outage. Resolved in ADR-0128: keyed by provider (`anthropic`/`openai`), not tenant, not fully global.
2. **What counts as a "failure"?** A tenant's own invalid/revoked API key fails on every call, indefinitely - if that counted toward a shared, provider-keyed circuit, one tenant's bad key would degrade every *other* tenant on the same provider. Resolved in ADR-0128: `ProviderRoutingLlmClient` classifies each failure by HTTP status before recording it - 400/401/403/404/422 (tenant-specific: bad key, bad request, bad model id) never count; everything else (5xx, 429, timeouts, network errors, malformed responses) does.

## Decisions

- **`LlmCircuitBreakerService`** - a small, explicit state machine (`closed` → `open` after 5 consecutive countable failures → `half_open` after a 30s cooldown, allowing exactly one trial call → `closed` on success or back to `open` on failure), state held per-provider, in-memory, per-process.
- **`ProviderRoutingLlmClient`** gates every call through `circuitBreaker.beforeCall` before touching the network, and reports outcomes back via `recordSuccess`/`recordFailure(provider, countable)`. A short-circuited call throws the same `LlmCallFailedError` a real failed call would - **zero changes needed to any of the five interaction-generating services' own degraded-mode `catch` blocks** to benefit from the breaker.
- **Drive-by fix**: `LlmCallFailedError`'s message previously hardcoded "Anthropic API call failed" even when OpenAI was the actual failing provider - a real, pre-existing bug that became functionally relevant once accurate per-provider attribution mattered for two independently-tracked circuits. Fixed with a backward-compatible optional `provider` constructor parameter.
- **Metrics**: `MetricsService.llmApiCallsTotal` gains a `short_circuited` result value (distinct from `error` - a spike here means the breaker is protecting the system, not that the provider newly broke), and its help text was corrected from "Anthropic API call outcomes" to reflect BYOK's multi-provider reality. `circuitBreakerStateTransitionsTotal` (declared but unwired since Phase 1) is now a real, observed metric.

## Consequences / Verification

- 17 new unit tests: `LlmCircuitBreakerService`'s own state machine (9 tests, using Jest's fake timers to control the 30s cooldown deterministically rather than real sleeps) and `ProviderRoutingLlmClient`'s integration (8 tests - the first in this module's suite to actually mock the real `@anthropic-ai/sdk`/`openai` packages, proving the gate, the classification logic against real SDK `APIError` shapes, and the provider-attribution fix all work together). 97 tests total, up from 80, all passing.
- `npm run typecheck`/`build`/`lint` all clean; a full app re-boot against the same running Postgres instance used in every prior phase succeeded with `LlmCircuitBreakerService` in the dependency graph; `/metrics` inspected directly and confirmed the corrected `ai_llm_api_calls_total` help text and the newly-wired `ai_circuit_breaker_state_transitions_total` metric are both live.
- No live LLM provider outage was available to observe in this session (same disclosed posture as every prior phase's "no live LLM call was made") - the breaker's behavior against a genuinely failing Anthropic/OpenAI API is proven via mocked SDK errors, not a live incident.
- What's next: Phase 8 (prompt-injection test suite - `askQuestion`'s all-free-text input is now the highest-priority target - plus dashboards for the newly-wired circuit breaker/degraded-mode metrics, and the real security review, which still needs to close the `updateGovernancePolicy`/`configureAiProvider` RBAC gap named in every phase's own checklist since Phase 5).
