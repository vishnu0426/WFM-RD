# ADR-0162: `AiInteractionRateLimitGuard` closes an undisclosed LLM-cost/DoS gap on the five `AIInteraction`-generating operations

## Context

Every prior phase of this module disclosed its gaps honestly - JWT
revocation, provider-config history growth, the suspicious-language
detector's evadability, `OllamaReachabilityChecker`'s point-in-time
validation, the outstanding security review. Rate limiting was not among
them, at any phase, for any reason - not disclosed as deferred, not
mentioned as a non-goal. Reading the code directly (not the docs) turned
up the actual state: nothing bounded *how often* a caller could invoke
`explainSchedule`, `explainForecast`, `explainReallocation`,
`rootCauseAnalysis`, or `askQuestion` - each of which persists a new
`AIInteraction` row and incurs a real, billable LLM API call to whichever
BYOK provider the tenant configured. `askQuestion`'s 4,000-character
length cap was the module's only existing guard against abuse of any
kind, and it bounds cost-per-call, not call frequency. A tenant (or a
compromised/leaked token for one) could drive real, unbounded LLM spend
with a tight request loop, with nothing in this service noticing or
slowing it down.

## Decision

**A fourth guard, `AiInteractionRateLimitGuard`, added after
`TenantTokenMatchGuard`** in all five resolvers'
`@UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard,
AiInteractionRateLimitGuard)` lists - it only spends a token-bucket check
on a request that already passed authentication and authorization, not on
a caller who was going to be rejected anyway.

**`AiInteractionRateLimiterService`: an in-process token bucket keyed by
`(tenantId, actorId)`**, `actorId` read from the already-verified
`request.tokenClaims.sub` (the same claim `@CurrentTokenClaims()` exposes
to the resolver itself - a Guard runs before resolver-argument binding, so
it reads the request directly rather than receiving the claim as a
parameter). Own copy of integration-hub-service's `RateLimiterService`
shape (ADR-0140) - a real token bucket, not a fixed-window counter -
crossed with shift-marketplace-service's `ClaimAttemptRateLimiterService`
per-tenant-override-map convention (`AI_INTERACTION_RATE_LIMIT`/
`_WINDOW_SECONDS`/`_OVERRIDES`, same flat-env-config placeholder posture
every per-tenant limit in this platform takes, since no tenant-settings
service exists anywhere to hook a real one into).

**In-process, not Redis-backed** - this service has no Redis of its own
today, and standing one up purely to make this limiter correct across
multiple replicas would be disproportionate to what closing this specific
gap needs. Same disclosed, accepted trade-off ADR-0140 already took for
the identical reason: single-instance-correct, multi-instance-approximate.
A real multi-replica deployment of this service would need a shared store
for this limiter to be globally accurate - a real, named gap, not solved
here.

**Per-actor, not per-tenant-only** - scoping by `(tenantId, actorId)`
rather than `tenantId` alone means one abusive user within a tenant can't
exhaust the whole tenant's quota and lock out their own colleagues, the
same reasoning `ClaimAttemptRateLimiterService` applies scoping per
`(tenantId, employeeId)` rather than per tenant.

**`AiInteractionRateLimiterService`/`AiInteractionRateLimitGuard` live in
`src/auth/`, registered in `AuthModule`, not `AiModule`** - the limiter
has no consumer besides its own guard, and co-locating both keeps the
concern self-contained rather than adding a new cross-module import edge
purely to share one service. `AiGraphQLModule` re-provides the guard
directly in its own `providers` array, matching the *already-documented*
DI quirk this module's own `AiGraphQLModule` doc comment names for the
other three guards ("a guard imported only via a sibling module's
`exports` did not resolve reliably here in practice").

## Consequences

- Verified: `tsc --noEmit`, `eslint`, and the full unit suite (194 tests,
  up from 186 - 8 new tests across
  `ai-interaction-rate-limiter.service.spec.ts` and
  `ai-interaction-rate-limit.guard.spec.ts`, matching this module's own
  per-guard spec convention rather than one combined `rbac.spec.ts`) all
  pass.
- `ai_interaction_rate_limit_checks_total{result}` is this module's first
  rate-limit observability signal - a spike in `exceeded` reads as either
  abuse or a limit set too low for legitimate usage, the same ambiguity
  every other anti-abuse counter in this platform already carries and
  resolves the same way (a human reading it alongside other signals).
- Every existing resolver-level test continues to call the underlying
  `*Service` classes directly, never through the HTTP/GraphQL layer
  `@UseGuards` enforces - nothing broke, and nothing proved the guard is
  wired short of the new guard-level tests above and a future real
  end-to-end pass (this module has no combined `rbac.spec.ts` the way
  integration-hub-service/adherence-compliance-service do; the three
  pre-existing per-guard specs already established that as this module's
  own convention).
