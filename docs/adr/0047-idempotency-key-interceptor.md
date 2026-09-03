# ADR-0047: `Idempotency-Key` support is a global interceptor, opt-in, Redis-backed, REST-only

## Context
§3.2 names `Idempotency-Key` as a cross-cutting REST requirement, deferred
explicitly by name in ADR-0020 (bulk import), ADR-0025 (refresh token
rotation), and Phase 2's own design doc - "Phase 6" the whole way through.
No shared implementation existed anywhere in this repo before this phase.

## Decision
`IdempotencyInterceptor`, registered once as a global `APP_INTERCEPTOR`
(`app.module.ts`), not per-controller. It only acts when *both* conditions
hold: the request is a plain HTTP `POST`/`PUT`/`PATCH`/`DELETE` (checked via
`context.getType() !== 'http'` bailing out first - GraphQL mutations are
not covered, see the consequences below), and the caller sent an
`Idempotency-Key` header. Absent the header, every request behaves exactly
as it did before this interceptor existed - this is additive, not a
behavior change for existing callers.

A first request with a given key executes normally; its response
(status + body) is cached in Redis for 24h, keyed by
`idempotency:<tenantId>:<key>`. A replay with the same key within that
window gets the cached response verbatim, without the handler running
again. A concurrent duplicate (same key, still in flight) is rejected with
`409 Conflict` rather than silently serialized behind the first one -
`RedisService.setIfNotExists` (`SET key value EX ttl NX`, newly added) is
the atomic "did I win the race" check backing that.

`/oauth/*` is deliberately excluded in spirit (not by an explicit
skip-list - it's just that OAuth clients have no reason to send this
header): PKCE codes are already single-use, refresh rotation already has
family-based reuse detection (ADR-0025). Stacking a second idempotency
mechanism on top would be redundant, not protective.

## Consequences
- GraphQL mutations are not covered - there's no per-field HTTP semantics
  to hang a header off of, and (per ADR-0045) this module's own GraphQL
  surface has no mutations yet anyway. A future GraphQL mutation that needs
  idempotency will need its own mechanism (an `idempotencyKey` input field,
  most likely), not a retrofit of this interceptor.
- On a Redis outage, `setIfNotExists` fails open to `true` (§1: Redis is
  never a hard dependency for a request to succeed) - meaning a genuinely
  concurrent duplicate could both execute during an outage. This is a
  known, accepted trade-off: `Idempotency-Key`'s entire value proposition
  already depends on Redis being up; failing closed instead would make a
  Redis outage block every mutating request platform-wide, a strictly
  worse outcome than occasionally losing dedup protection for the
  (already rare) concurrent-duplicate case during that specific outage
  window.
- The cached response is a fire-and-forget write (`tap`'s `next` callback
  isn't awaited before the response returns to the client) - a crash
  between the handler completing and the cache write landing means a
  same-key retry re-executes the handler instead of replaying. Given the
  handler itself is expected to be safe to call with the same
  business-level inputs (that's the premise `Idempotency-Key` exists to
  paper over rare double-submits, not to replace idempotent handler
  design), this is judged an acceptable, narrow gap, not a hidden
  correctness issue.
