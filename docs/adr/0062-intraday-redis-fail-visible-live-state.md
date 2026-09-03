# ADR-0062: Module 05's Redis client is fail-*visible*, an explicit departure from the platform's fail-open Redis convention

## Context
Every existing Redis consumer in this platform (`src/common/redis/redis.service.ts`,
used by `UserContextCacheService`, `RefreshTokenService`, `TokenService`'s
revocation check, `IdempotencyInterceptor`) is built on one hard rule, stated
directly in that class's own doc comment: "Redis backs
performance/fast-path optimizations only... a Redis outage must degrade
latency, not availability." Every method on `RedisService` fails open -
logs a warning and returns a cache-miss shape (`null`/`false`/`true` as
appropriate) - because every caller has a correct, if slower, Postgres-only
fallback.

Module 05's `AgentLiveState`/`QueueLiveState` (§2.1) have no such fallback.
Redis is not a cache in front of Postgres here - per the module prompt's
§1, it is *the system of record for current state*, a deliberate departure
from every other module's Postgres-first pattern. There is no "slower but
correct" path to fall back to for "what is this agent doing right now" - if
Redis can't answer, this service genuinely does not know. Silently
returning stale or empty data here is exactly the failure mode §6.1 calls
out by name: "live dashboard state must never silently go stale without
saying so... a dashboard that looks live but isn't is worse for a
supervisor than one that visibly says 'data may be delayed.'" Copying
`RedisService`'s fail-open posture unmodified into this service would
directly violate that non-negotiable.

## Decision
`IntradayRedisService` (`intraday-service/src/redis/redis.service.ts`) is a
new, independent class - not an import of, or a subclass of, the root app's
`RedisService` - with the opposite failure contract for every data-path
method:

- `writeAgentLiveState`/`readAgentLiveState`/`writeQueueLiveState`/
  `readQueueLiveState` let a Redis error propagate as a typed
  `IntradayRedisUnavailableError` rather than swallowing it. A caller that
  can't distinguish "Redis said no data exists" from "Redis is unreachable"
  cannot correctly implement §6.1's `dataFreshness` staleness contract -
  that contract needs the distinction, so the client has to preserve it.
- `acquireIngestionIdempotencyLock` (this phase's one real write path) also
  fails closed: a Redis error means this service cannot guarantee it won't
  double-publish an ACD-retried event to NATS, and nothing downstream is
  built to tolerate that yet. `IngestionService` maps the thrown error to
  HTTP `503`, which the calling ACD/CCaaS system is already expected to
  retry - a visible, expected failure, not a masked one.
- `ping()` is the deliberate single exception, kept fail-*safe* (never
  throws, returns `{ ok: false, latencyMs }`): it exists specifically to
  *report* degraded status to `/readyz` and the future `dataFreshness`
  envelope, so it must be callable even when everything else about Redis is
  broken.
- `/readyz` (`HealthController`) reflects this directly: unlike the root
  app's `/readyz` (Redis unreachable is reported but does not fail the
  check, since Redis is only a cache there), this service's `/readyz`
  returns `503` when Redis is unreachable, because Redis unreachable here
  really does mean this instance cannot serve a correct live read.

This phase does not yet build §6.1's full `dataFreshness` response envelope
on a live-read API - there is no live-read API surface until Phase 4/GraphQL
and the Phase 4/7 REST snapshot fallback exist. This ADR establishes the
client-level contract (throw, don't swallow) that contract will be built on
top of, rather than retrofitting it later onto a client that was built to
hide errors.

## Consequences
- Every future write path in this service (the Phase 2 NATS consumer that
  actually populates `AgentLiveState`/`QueueLiveState`, the Phase 6
  reallocation-execution path) inherits fail-visible semantics automatically
  by using `IntradayRedisService` - there is no fail-open method to reach
  for by accident.
- A Redis outage now genuinely degrades *availability* for this service's
  live-read paths (once they exist) and for webhook ingestion specifically
  (this phase), not just latency - a real, accepted trade-off given §6.1's
  explicit instruction that looking-live-but-stale is worse than visibly
  degraded. The chaos/game-day exercise §0.5 names for this module ("kill
  the Redis primary... verify the degradation path actually engages") is
  what proves this in practice - that exercise is Phase 7 scope, not this
  phase's.
- `IntradayRedisService` and the root app's `RedisService` are two separate
  classes with two separate, intentionally different failure contracts for
  the same underlying technology. A future engineer must not "simplify" by
  unifying them - doing so would either silently reintroduce fail-open
  behavior into live-state reads, or force every existing fail-open cache
  consumer in the root app to start handling thrown errors it currently
  doesn't expect.
