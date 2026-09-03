# Module 12 Phase 5 Design Doc — Integration Hub: Rate Limiting for Batch Connectors

**Status:** Approved for implementation
**Owner:** Integration Hub pod (Module 12), Principal Integrations Engineer (§0's per-provider rate-limit design ownership).
**Scope:** Per §7 — "§5a's provider-quota throttle in full, with real per-provider limits researched and configured." Concretely: seeding `ProviderRateLimitConfig` with the real, sourced values from `docs/module-12-provider-research.md`; a proactive token-bucket throttle enforced by `BatchSyncRunnerService` *before* calling a provider; and a reactive backoff (`WorkdayAdapter`) for the case where the provider still returns a rate-limit response despite the proactive check.

## Problem

Two real mechanisms, not one - §5a itself draws this distinction and this phase had to make both concrete rather than conflating them:

1. **Proactive**: "the sync job runner enforces this *before* making calls, not reactively after a 429." This needed a real token-bucket implementation, scoped per `(tenant_id, connector_id)` per ADR-0135, seeded from the real researched `requests_per_window`/`window_seconds` values - and, since this service runs as a single process with no Redis presence, a real decision about where that bucket state lives (ADR-0140: in-process, a disclosed single-instance limitation, not solved with fake shared-state machinery this phase doesn't need yet).
2. **Reactive**: "on genuinely hitting a rate limit despite the proactive throttle, apply the provider's `backoff_strategy`... never silently truncate and report completed." `backoff_strategy`'s jsonb shape differs meaningfully across the 10 researched providers (ADR-0135) - this phase's reactive backoff (`withBackoffRetry`) only interprets the exponential shape (`base_ms`/`max_retries`/`respect_retry_after`) that Workday's own seeded row actually uses, not every shape in the research doc (e.g. Salesforce's `header_driven` shape is real, sourced data but has no consumer yet, since no Salesforce adapter exists).

## Decision

**Seed migration** (`1700010100000-SeedProviderRateLimitConfig.ts`) - all 10 researched providers, transcribed directly from `docs/module-12-provider-research.md`, run as `agno_migrator` per ADR-0136 (this table is `SELECT`-only for the app role). `null` values are the accurate transcription of "not publicly documented," not placeholders.

**`RateLimiterService.tryAcquire(tenantId, connectorId, provider)`** - a real token bucket (capacity = `requests_per_window`, refill rate = `requests_per_window / window_seconds` tokens/sec), in-process `Map` state (ADR-0140). Returns `{allowed: true}` unconditionally for a provider with no published `requests_per_window`/`window_seconds` (several of the 10 researched providers, by design - nothing to throttle against).

**`BatchSyncRunnerService.runOne`** calls `tryAcquire` immediately after `enqueue`, before `markRunning` - a throttled connector's `SyncJob` never transitions to `running` and never reaches `adapter.sync()` at all this tick. Completes as `partial_failure` with `errorDetails.reason: 'rate_limited'`, distinct from every other failure reason this module produces (§5a: "surface rate-limit-driven delays distinctly from actual failures").

**`withBackoffRetry`** (`src/sync/batch/providers/rate-limit-backoff.ts`) - a real exponential-backoff retry loop, reading the *calling* provider's own seeded `backoff_strategy`. `WorkdayAdapter.fetchWorkers` uses it: a 429 response is treated as a retryable outcome (respecting a real `Retry-After` header when `respect_retry_after` is configured), and exhausting `max_retries` throws `RateLimitExhaustedError`, caught by `sync()` and turned into a distinct `partial_failure` (`rate_limited_reactive_exhausted`) - never lumped into the generic `adapter_threw` bucket, never silently reported `completed`.

**Metrics**: `integration_hub_rate_limit_throttles_total{provider, kind}` - `kind: proactive` (the runner-level check) vs `reactive_retry` (every real 429 encountered) vs `reactive_exhausted` (retries ran out) - satisfying §5a's "surface... distinctly" at the observability layer too, for Phase 8's dashboard to consume later.

## Verification

**Unit**: `rate-limit-backoff.spec.ts` (7 tests, fake `sleepFn` so no real waiting) - first-attempt success, retry-then-recover, real exponential delay math (`base_ms * 2^attempt`), `Retry-After` respected when configured, falls back to exponential when no `Retry-After` value is given, exhaustion throws `RateLimitExhaustedError`, default `base_ms`/`max_retries` when a provider's config carries neither. `rate-limiter.service.spec.ts` (6 tests) - unconfigured/null-limit providers always allowed, capacity enforced then denied with a real `retryAfterMs`, buckets scoped independently per connector and per tenant, and a real-clock refill test (200ms window) proving the token math isn't just simulated.

**Real end-to-end, real Postgres + real seeded `ProviderRateLimitConfig` + real Vault** (`test/integration/rate-limiting.spec.ts`, 3 tests):
- **Proactive**: a dedicated test provider seeded with capacity 1; the first `tick()` reaches a stub adapter and completes; the second `tick()` (same tenant+connector, bucket empty) never calls the adapter at all - proven via a Jest mock call count, not just the returned status - and produces a real, distinct `SyncJob` row with `errorDetails.reason: 'rate_limited'`.
- **Reactive recovery**: a real local HTTP server returns a real `429`, then `200`; `WorkdayAdapter` (using Workday's real seeded `backoff_strategy`, temporarily shrunk to `base_ms: 10` for test speed - restored via `try`/`finally` immediately after) genuinely retries and recovers, confirmed via `metrics.recordRateLimitThrottle` having actually been called with `('Workday', 'reactive_retry')`.
- **Reactive exhaustion**: the same real server returning `429` on every attempt - `WorkdayAdapter` gives up after Workday's configured `max_retries`, returns `partial_failure` with `errorDetails.reason: 'rate_limited_reactive_exhausted'`, and records the distinct `reactive_exhausted` metric.

**Full suite**: 55 unit tests (up from 42) + 30 integration tests (up from 27), `typecheck`/`lint` clean.

## Blast radius

- New migration (`1700010100000-SeedProviderRateLimitConfig.ts`), new code within `integration-hub-service/`: `src/sync/provider-rate-limit-config.service.ts`, `src/sync/batch/rate-limiter.service.ts`, `src/sync/batch/providers/rate-limit-backoff.ts`. One new ADR (0140) and this doc.
- `BatchSyncRunnerService`/`WorkdayAdapter`/`MetricsService` modified (Phase 2/3 code) to wire in the new checks.
- No change to any other Module 12 entity's schema.

## Rollback plan

Revert this phase's commits, including the seed migration's `down()` (clears `provider_rate_limit_config`). `BatchSyncRunnerService` falls back to Phase 2/3/4 behavior (no throttle - every due connector always reaches its adapter). No other phase's code depends on this one.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Token bucket state is in-process, not Redis-shared** (ADR-0140) - a real, disclosed single-instance limitation, consistent with this platform's current one-instance-per-service deployment reality; not solved with premature shared-state infrastructure.
2. **`withBackoffRetry` only interprets the exponential `backoff_strategy` shape** - the one shape this phase's one real consumer (`WorkdayAdapter`) actually needs. `header_driven` (Salesforce), `respect_retry_after` (Genesys), and the various `is_published: false` shapes are real, seeded, un-consumed data until a real adapter for those providers exists (Phase 6b) and needs to interpret its own provider's shape - matching ADR-0135's own point that `backoff_strategy` is provider-adapter-interpreted, not a fixed shared schema.
3. **A throttled connector's `SyncJob` is `partial_failure`, not `queued`/left pending.** The next cron tick will pick the connector up again naturally (nothing marks it "already tried" beyond the completed job), so there's no risk of it being stuck - but each throttled attempt does produce a new, visible `SyncJob` row rather than silently retrying in place.

## Out of scope for this phase (do not build yet)

- Any ACD/streaming adapter, or `concurrent_request_limit`'s repurposed streaming semantics (ADR-0135) - Phase 6.
- Remaining batch adapters (SAP SuccessFactors, ADP, Salesforce) and their own `backoff_strategy` shapes (`header_driven` for Salesforce specifically) - Phase 6b.
- `WebhookSubscription`/`WebhookDelivery`, the outbound dispatcher - Phase 7.
- Connector health dashboard (surfacing the new rate-limit metrics/distinct `SyncJob` reasons visually), remaining GraphQL surface, dashboards/runbooks, the shared-store fix ADR-0140 flags - Phase 8.
