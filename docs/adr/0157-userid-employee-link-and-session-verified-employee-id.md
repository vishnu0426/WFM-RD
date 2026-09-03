# ADR-0157: Close the `userId -> Employee` gap and verify `employeeId` against the caller's own session

## Context

ADR-0150 named two gaps and deliberately left both open: no `userId ->
Employee` reverse lookup anywhere in the platform, and every mobile-ess-service
endpoint that takes a client-supplied `employeeId` (`syncOfflineActions`,
`registerDevice`, `geofence-config`) accepting it as-is, with no check that it
belongs to the caller. Both are closed here.

Research also found `EmployeeResolver` (`src/modules/employee/graphql/employee.resolver.ts`)
had no guards at all — `createEmployee`/`updateEmployee`/`transferEmployee`
were completely open. Adding a `userId` link field to `updateEmployee`
without also gating the resolver would have let any caller re-link any
employee to any user, so gating it is treated as a required companion fix,
not a separate initiative.

## Decision

**`Employee.userId` gets a reverse lookup and a link/unlink path.**
`EmployeesRepository.findByUserId(userId)` (root platform-core), backed by a
new partial unique index, `CREATE UNIQUE INDEX ON org.employees (tenant_id,
user_id) WHERE user_id IS NOT NULL` — nothing previously prevented two
employees sharing one `userId`. `UpdateEmployeeInput.userId?: string | null`
links (a UUID) or unlinks (`null`); omitting the field leaves the existing
value untouched. A unique-violation on write is remapped to
`UserAlreadyLinkedError` (`USER_ALREADY_LINKED`), not a raw 500.

**`EmployeeResolver` is gated for the first time.**
`@UseGuards(AccessTokenGuard, PermissionsGuard)` at class level,
`employee:read`/`employee:write` `@RequirePermissions(...)` per handler —
same pattern as `PolicyResolver`/`UserResolver`. `employee:read`/`write` were
added to the seed permission catalog and granted to `tenant_admin`, since no
`employee` resource existed there at all before this.

**`me { employee { ... } }` is real.** `UserResolver` gained a
`@ResolveField` backed by `findByUserId(user.id)` — any authenticated client
can now resolve its own linked `Employee`, not just the reverse (already
existed).

**A new gRPC RPC exposes the same lookup cross-service.**
`EmployeeService.GetEmployeeIdForUser(tenant_id, user_id) ->
{found, employee_id}` (sparse/absent-not-error shape, same convention as the
rest of this contract) — GraphQL's `me` query isn't reachable from another
service, so this is how mobile-ess-service (and any future caller) resolves
a JWT's `sub` claim to a real `Employee.id`.

**mobile-ess-service now verifies `employeeId` against the session.**
`EmployeeSessionVerificationService.assertEmployeeIdMatchesSession(claims,
employeeId)` — resolves `claims.sub` via the new RPC and throws
`ForbiddenException` on any mismatch. Applied to all three endpoints that
accept a client-supplied `employeeId`: `MobileSyncController.sync` (checked
per distinct `employeeId` across the whole action batch — a batch mixing in
another employee's `employeeId` is rejected outright, not silently
filtered), `DevicesController.register`, `GeofenceConfigController.getConfig`.
`AccessTokenGuard`'s claims already carried `sub` (inherited from `jose`'s
`JWTPayload`) — no guard change was needed, only a first real consumer of
it.

**attendance-leave-service gets its own copy of the guard pair.**
`AccessTokenGuard`/`TenantTokenMatchGuard` copied verbatim from
mobile-ess-service (new `jose` dependency, `CORE_JWKS_URI`/`OIDC_ISSUER`/
`OIDC_AUDIENCE` added to `.env.example`), plus its own `EmployeeGrpcClientModule`
(this service's first `EmployeeService` client) and its own copy of
`EmployeeSessionVerificationService`. Applied to `EmployeeAttendanceRecordController`
and `EmployeeLeaveBalanceController` — the two endpoints research confirmed
were both guardless and real external-facing (mobile-app calls them
directly, not routed through mobile-ess-service). `mobile-app`'s `apiGet`
already attached `Authorization: Bearer <accessToken>` to every call
(ADR-0150) even before these endpoints checked it, so no mobile-app change
was needed.

## Consequences

- A row in `org.employees` with a non-null `user_id` that collides with an
  existing link now fails at write time (`USER_ALREADY_LINKED`), not
  silently — any pre-existing duplicate `userId` values in seed/demo data
  would need cleanup before the migration's unique index applies; none exist
  today, so this is a forward-looking constraint only.
- `mobile-ess-service`'s three endpoints now make one extra gRPC round-trip
  per request (bounded by the same `CALL_TIMEOUT_MS = 3000` as
  `getEmployeeOrgUnits`) — no caching layer added, matching this service's
  existing per-request-gRPC-call posture elsewhere.
- An employee whose `Employee.userId` was never linked (created before this
  ADR, or created without a `userId`) cannot pass `assertEmployeeIdMatchesSession`
  for any `employeeId` at all — `GetEmployeeIdForUser` returns `found: false`,
  so no `employeeId` will ever match. Existing demo/seed employees must have
  `userId` set for mobile self-service flows to keep working after this
  change ships.
- attendance-leave-service's two now-guarded endpoints make the same extra
  gRPC round-trip per request as mobile-ess-service's three; no caching
  layer added there either.
- Broader `TenantContextMiddleware` hardening across the other six services
  remains out of scope, named in the parent plan, not silently dropped.
