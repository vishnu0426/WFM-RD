# ADR-0152: `POST /v1/mobile/sync` is gated by real JWT verification from day one, uses client-generated ids for idempotency, and processes each batch strictly sequentially

## Context

`mobile-ess-service` is a genuinely new backend service and
`POST /v1/mobile/sync` is a genuinely new write endpoint — unlike
Module 11's read-only calls to scheduling-service (Phase 1, inheriting
that service's existing `X-Tenant-Id`-only trust posture, ADR-0014), this
endpoint creates real `AttendanceRecord` rows on an employee's behalf. Three
real design decisions had to be made, each with a precedent already
established elsewhere in the platform.

## Decision

**Real JWT verification (`AccessTokenGuard` + `TenantTokenMatchGuard`),
copied from ai-layer-service/integration-hub-service (ADR-0130, ADR-0145),
not the `X-Tenant-Id`-only placeholder every other module's Phase 1
started with.** A new write endpoint that produces real attendance data is
exactly the kind of "escalating risk" those two ADRs already established
real RBAC for — applying the same bar to a brand-new endpoint, rather than
accumulating the same tech debt a third time, is the more defensible
default. `PermissionsGuard` is deliberately NOT applied: there is no
`userId -> Employee` lookup anywhere in the platform (ADR-0150's gap #2,
carried forward unchanged), so this service cannot verify the JWT's owner
actually *is* the `employeeId` named in a given action — a permission
string would gate nothing beyond what `TenantTokenMatchGuard` already does.
`employeeId` remains client-supplied and unverified against the session,
the same named, carried-forward gap ADR-0150 already disclosed.

**Client-generated `id` as the real idempotency mechanism, not the
platform's generic Redis-backed `IdempotencyInterceptor`
(`src/common/http/idempotency.interceptor.ts`).** That interceptor is real
and reusable, and declining it is a deliberate trade, not an oversight: it
would require Redis as a new infrastructure dependency for a service that
otherwise needs none. Each `OfflineActionQueue.id` is minted client-side at
queue time and doubles as the primary key — a terminal row (`synced`/
`conflict`) short-circuits to its cached result; a `pending_sync`/`failed`
row is (re)processed. A genuinely concurrent double-insert (two requests
racing for the same not-yet-existing id — a real scenario once the mobile
client's own storage mutex, see the Phase 3 design doc, allows a reconnect
handler and an app-foreground handler to both fire sync at once) is caught
via `isUniqueViolation` and resolved by reloading the now-existing row,
the exact same pattern `attendance-ingestion.service.ts` already uses for
its own `(tenantId, source, sourceEventId)` dedup.

**Each sync batch is processed strictly sequentially, in array order —
never `Promise.all`.** A batch containing a `clock_in` followed later by a
`clock_out` for the same employee (the ordinary end-of-offline-shift case)
would otherwise race the clock-out's open-record read against the
clock-in's still-in-flight transaction, producing a spurious conflict that
has nothing to do with the employee's actual attendance. The mobile client
sends actions in `createdAtDevice` order; this service preserves that
order rather than parallelizing for throughput.

## Consequences

- `POST /v1/mobile/sync` requires a real, currently-valid Bearer token
  whose `tenant_id` claim matches the request's `X-Tenant-Id` header — a
  caller with only a spoofed header (sufficient for scheduling-service's
  read endpoint) cannot use this endpoint at all.
- Throughput is bounded by sequential per-action processing, not
  parallelism — acceptable given the batch cap is 50 actions and this is
  a background sync operation, not a latency-sensitive live request.
- `employeeId`-spoofing within a validly-authenticated session for a
  *different* employee of the *same* tenant remains possible — named here,
  not fixed, same posture as ADR-0150. Closing it requires the
  `userId -> Employee` lookup Module 02 doesn't expose yet.
- A future phase adding `leave_request`/`marketplace_claim` processing
  (Phase 4) must preserve the same sequential-batch-processing discipline
  if those action types can also race against each other or against a
  `clock_event` in the same batch.
