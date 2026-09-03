# ADR-0090: claim-attempt-specific rate limiting, distinct from any generic request quota

## Context
§5.2 flagged this explicitly as an open risk: "a legitimate high-frequency
user (checking for new open shifts) looks identical to a scripted
rapid-fire claimer at the API-gateway-quota level." Module 01's own
tenant-level Envoy token-bucket (§3.4 there) protects the whole platform
from raw request volume, but it has no concept of *which* mutation is
being called repeatedly - it would throttle a legitimate burst of
unrelated marketplace browsing exactly as readily as it throttles someone
scripting `claimOpenShift` against every post in a tenant. §5.2 asks for
something narrower: "add a claim-attempt-specific limit at the endpoint
level... reject with a clear, distinct error (not a generic 429)... state
actual defaults while making both configurable per tenant... distinguish
this in logging/metrics from legitimate high-frequency use... failed/
rejected claim attempts still count... but successful claims and
legitimate browsing do not."

## Decision

**A new `ClaimAttemptRateLimiterService`**, checked first in
`ClaimOpenShiftService.claim()` - before the Redis lock, before any
database write, before Module 04's gRPC guardrail call. A rate-limited
caller never reaches any of §4's own machinery; this is abuse defense on
top of the concurrency-safe flow, not a replacement for it.

**Persisted on `MarketplaceEngagementScore.claimAttemptCountWindow`/
`claimAttemptWindowStart`** (§2.1's own fields, already shipped in
Phase 1's migration specifically for this use) rather than Redis or a new
table - this counter's natural lifetime matches engagement data's, not a
cache TTL, and reusing the existing per-`(employee, tenant)` row avoids a
second place to look up "this employee's own marketplace standing." Every
query goes through the same `withTenantConnection` RLS-scoping idiom as
every other table access in this service - the first draft of this file
queried `marketplace_engagement_score` directly and was caught before any
test ran (`test/integration/claim-attempt-rate-limiter.spec.ts`'s own
"RLS fails closed" case now proves what that bug would have done: not a
silent leak, but a hard cast error once any prior request on the same
pooled connection had already set the tenant GUC and committed - Postgres
resets a custom placeholder GUC's `SET LOCAL` value to `''`, not `NULL`,
once it's been set at all in that session, and `''::uuid` fails the cast
before RLS's own comparison ever runs).

**Defaults: 10 attempts per 60-second window per `(tenant, employee)`**,
both configurable per tenant (`MARKETPLACE_CLAIM_ATTEMPT_LIMIT`/
`MARKETPLACE_CLAIM_ATTEMPT_WINDOW_SECONDS`, with a
`MARKETPLACE_CLAIM_ATTEMPT_LIMIT_OVERRIDES` JSON map override) - the same
flat-env-config placeholder posture `TenantMarketplacePolicyService`
already uses, since no tenant-settings service exists anywhere in this
platform yet to hook a real per-tenant configuration into. A single
atomic `INSERT ... ON CONFLICT DO UPDATE` (not a read-then-write)
increments the counter, so two genuinely concurrent failed attempts from
the same employee can never lose an increment to each other; the window
itself resets on the first write after it elapses, not on a separate
sweep.

**`ClaimAttemptRateLimitExceededError`** is its own `DomainError` subclass
mapped to `429 Too Many Requests` in `domain-error.filter.ts` - a
distinct, named error (`CLAIM_ATTEMPT_RATE_LIMITED`) carrying
`retryAfterSeconds`, not a generic 429 a caller has no way to reason
about, per §5.2's own explicit ask.

**What counts as a failed attempt, decided once in `ClaimOpenShiftService.
claim()`**:
- Losing the Redis lock (`PostAlreadyBeingClaimedError`) - counts. A real,
  user-attributable attempt, even though it never reaches the database.
- `MarketplacePostNotFoundError`/`PostNotOpenError` - counts. A stale post
  or bad ID is still a real attempt.
- A claim that reaches `REJECTED` (guardrail-ineligible or stale-post) -
  counts.
- A claim that reaches `PENDING_APPROVAL`/`APPROVED` - never counts. §5.2:
  "successful claims... do not."
- `MarketplaceUnavailableError` (Redis down) or any guardrail-gRPC failure
  bubbling out of `processClaim` - never counts. This limiter exists to
  catch abusive *use*, not to penalize a caller for this platform's own
  infra hiccups; an infra outage should never also lock legitimate callers
  out once it recovers.

**Metrics distinguish the abuse signal from every other outcome**:
`marketplace_claim_attempts_total{result}` in `MetricsService`, with
`result=rate_limited` as its own label value - never folded into
`rejected` or any other outcome, so a spike here reads unambiguously as
"the limiter is firing," satisfying §5.2's "distinguish this in logging/
metrics from legitimate high-frequency use" directly in the one place an
operator would actually look.

## Consequences
- Verified against real, RLS-protected Postgres
  (`test/integration/claim-attempt-rate-limiter.spec.ts`), not just mocks:
  real threshold enforcement, real cross-tenant isolation for the same
  employee id, real atomic-upsert behavior under genuine concurrent
  writes, and the RLS-fails-closed property this exact service's own
  build caught a real bug against.
- The limiter is keyed on `(tenant, employee)`, not IP or session - a
  single employee account scripted from many IPs is still caught; a
  botnet of many distinct fabricated employee identities would not be
  (out of scope here, same posture as every other placeholder-auth
  mutation in this service - real identity/fraud defense is a future
  platform-wide phase, not this module's to solve).
- Rate-limited attempts are invisible to `MarketplaceEngagementScore`'s
  own points/streaks/badges (Phase 7) - the same row's two columns serve
  two different purposes (abuse counter vs. gamification ledger) without
  interfering with each other, since Phase 7 only ever touches the
  `points`/`streak_days`/`badges` columns and this phase only ever touches
  `claim_attempt_count_window`/`claim_attempt_window_start`.
