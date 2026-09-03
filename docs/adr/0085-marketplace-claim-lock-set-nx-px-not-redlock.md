# ADR-0085: single-instance Redis `SET NX EX` for the claim lock, not Redlock; 5-second TTL; per-attempt token with compare-and-delete release

## Context
§1's tech-stack table mandates "a Redis distributed lock (e.g. Redlock
algorithm or a single-instance `SET NX PX` with a well-chosen TTL - state
which and why), keyed on `marketplace_post_id`, fast-fail on contention,"
explicitly deferring the Redlock-vs-single-instance choice to this module's
own build. §0's non-negotiable is that this lock is the module's *actual*
concurrency-safety mechanism (not Postgres row locking, explicitly
rejected in the source spec on latency-under-contention and UX grounds) -
so both the algorithm and the TTL need a real, stated rationale, not a
default carried over from convenience.

## Decision

**Single-instance `SET key token EX ttlSeconds NX`, not Redlock.** Every
Redis-as-lock usage that already exists in this platform
(intraday-service's `acquireIngestionIdempotencyLock`, ADR-0062) is
single-instance; nothing in this platform's `docker-compose.yml` runs a
multi-node Redis deployment (Sentinel/Cluster) that Redlock's own
multi-instance quorum algorithm is designed to protect against a
single-node failure for. Adopting Redlock against a single Redis instance
buys none of its actual safety property (it degenerates to the same
single-point-of-failure as `SET NX` alone) while adding real complexity
(multiple independent Redis clients, a quorum-acquire loop, clock-drift
accounting) for a platform-wide deployment topology that doesn't exist yet.
If a future phase moves this platform's Redis to a genuinely multi-node
topology, revisit this decision then - not preemptively today.

**5-second TTL.** `SchedulingEligibilityGrpcClientService`'s own call
timeout is 3000ms (chosen to absorb scheduling-service's ~2.1s worst-case
upstream-gRPC retry budget, ADR-0082) - 5 seconds gives the full claim
pipeline (the pending_validation write, the guardrail gRPC round-trip, the
final status-transition write) comfortable margin beyond that 3000ms
budget without approaching the tens-of-seconds range where a crashed
request would leave a post genuinely stuck for an uncomfortably long time
if the best-effort release never runs at all.

**Per-attempt random token, released via a compare-and-delete Lua script,
not a plain `DEL`.** Distinct from intraday-service's own
`acquireIngestionIdempotencyLock`/`releaseIngestionIdempotencyLock` pair
(ADR-0062), which uses a plain `DEL` on release - that lock only ever needs
"did *someone* already claim this," never "release *my* claim
specifically," so an unsafe release can't cause a real correctness bug
there. This lock protects a live claim attempt across a real network
round-trip against its own short TTL: if a lock winner's gRPC call runs
unusually long (approaching or exceeding the 5-second TTL under a slow
upstream), the TTL could expire mid-attempt, let a second claimant acquire
the lock and start its own attempt, and then have the *first* claimant's
delayed release plainly `DEL` the *second* claimant's still-active lock -
the classic unsafe-Redlock-release bug, still possible even in a
single-instance deployment. A random per-attempt token plus a `GET`+
compare+`DEL` Lua script (one atomic Redis command, no window for a third
party to race into) closes this - see `MarketplaceRedisService`'s own
`RELEASE_SCRIPT`.

## Consequences
- `MarketplaceRedisService` is a deliberate, independent copy of
  intraday-service's `IntradayRedisService` fail-*visible* posture
  (ADR-0062) - a Redis error during `acquireClaimLock` throws
  `MarketplaceRedisUnavailableError` rather than being swallowed, mapped by
  `ClaimOpenShiftService` to `MarketplaceUnavailableError` (§0.5's chaos
  scenario: fail closed, never fall back to an unlocked DB write).
  `releaseClaimLock` is the one deliberate exception, best-effort/fail-open
  on cleanup only - the TTL is the correctness backstop if it never runs,
  not the primary release path.
- §0.5's own SLO (claim lock acquisition -> lose/win response, p99 <
  100ms) is unaffected by the TTL choice - TTL only bounds how long a
  *crashed* attempt can block a post, not the latency of a normal
  acquire/release cycle, which is a single round-trip Redis command either
  way.
- If a future load test (§0.5/§7's own release-gate artifact) finds 5
  seconds too short under real p99 guardrail-validation latency (e.g. a
  genuinely degraded but not fully unavailable Module 04), this is a
  one-line constant change (`CLAIM_LOCK_TTL_SECONDS`,
  `claim-open-shift.service.ts`), not a re-architecture.
