# ADR-0084: `X-Actor-Id` header widening for shift-marketplace-service, mirroring intraday-service's ADR-0069

## Context
`claimOpenShift` needs to know *who* is claiming, not just which tenant -
the claimant's employee id is never a client-supplied GraphQL argument
(§3.1's own mutation signature is `claimOpenShift(postId: ID!)`, no
`employeeId`), so it has to come from request context, the same way
`tenantId` already does via `TenantContextService.requireTenantId()`.

This service's `TenantContextService`/`TenantContextMiddleware` were
scaffolded from attendance-leave-service's Phase-1 copy (Phase 1, before
any mutation needed an actor at all), which has no actor-identity concept
whatsoever. Two other services in this platform already solve this
differently: attendance-leave-service takes the actor as a plain,
fully-trusted request-body field (`decidedBy`, `employeeId` on
`RequestLeaveDto`/`DecideLeaveRequestDto`) - explicitly flagged in its own
code comments as a stopgap, not a pattern to imitate for a new service;
intraday-service instead widened its `TenantContextService`/middleware to
optionally carry an `actorId`, sourced from an `X-Actor-Id` header, same
trust-as-is placeholder posture as `X-Tenant-Id` (its own ADR-0069). Root
platform-core's real JWT-derived identity (ADR-0049) binds `actorId` from a
verified token's `sub` claim - not available here, since this service has
no JWT-verification dependency at all.

## Decision
Widen this service's own `TenantContextStore`/`TenantContextService`/
`TenantContextMiddleware` to intraday-service's `X-Actor-Id` pattern
exactly: `actorId?: string` on the store, read from an optional
`X-Actor-Id` header (trusted as-is, same placeholder posture as
`X-Tenant-Id`, ADR-0014), a `requireActorId()` method that throws
`ActorContextMissingError` (a `DomainError`) only at the point of use. A
request with a valid `X-Tenant-Id` but no `X-Actor-Id` still binds tenant
context fine - only `claimOpenShift` (and Phase 3/4's `proposeSwap`/
`respondToSwap`/`submitBid`) actually call `requireActorId()`.

Chosen over attendance-leave-service's client-supplied-field approach for
the same reason intraday-service's own precedent exists: a request-body
`employeeId` a claimant supplies for themselves has no distinction from
one supplied on someone else's behalf, which matters more here than it did
for attendance-leave-service's original Phase 3 (a `RequestLeaveDto` a
supervisor might legitimately submit on an employee's behalf) - a
marketplace claim is inherently "I am claiming this for myself," and a
context-bound actor id is the closer fit.

## Consequences
- `ActorContextMissingError` is a `DomainError` surfaced via the GraphQL
  `formatError` hook (`MarketplaceGraphQLModule`'s own `formatGraphQLError`),
  not the REST `DomainErrorFilter` - every place this error can actually be
  thrown in this service is a GraphQL resolver, never a REST controller
  (this service's only REST surfaces are `/healthz`/`/readyz`/`/metrics`,
  none of which touch actor identity).
- Real identity verification (JWT or a gRPC call to Module 01's
  `IdentityService`) remains out of scope for this phase, same explicit gap
  every other service's own placeholder-header ADR states - not
  rediscovered as a surprise later, tracked here as a known, shared
  platform gap.
- A future real-auth fix closes this gap the same way it would for
  intraday-service or root - this ADR doesn't need to be revisited itself,
  only superseded.
