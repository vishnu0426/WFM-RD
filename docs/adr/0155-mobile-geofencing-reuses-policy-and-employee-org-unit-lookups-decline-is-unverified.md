# ADR-0155: Geofencing reuses `Policy`/`GetActivePolicy` and `GetEmployeeOrgUnits` as the entire opt-in mechanism; a declined location is treated as an unverified one, not silently downgraded

## Context

§5b's requirement: on a `clock_event` (online or offline), capture device
location, validate against the employee's org unit's configured geofence
boundary, store the result — tenant opt-in only, default off, per-org-unit
configuration, out-of-bounds flagged for supervisor review rather than
hard-blocked unless the tenant explicitly configures hard enforcement.

Research confirmed no geofence/location infrastructure existed anywhere
in the platform before this phase — but two already-real, already-
deployed mechanisms fit the need almost exactly: `Policy`
(`core.policies`, org-unit-scoped configuration, `PolicyService.
GetActivePolicy` gRPC, already exposed for cross-service reuse) and
`EmployeeService.GetEmployeeOrgUnits` (built in ADR-0099 specifically to
close an employeeId→orgUnitId gap for another consumer). This phase's
central decision is reusing both rather than inventing new entities or
RPCs, plus one genuinely novel security-relevant call: what a declined
location permission means for enforcement.

## Decision

### 1. Opt-in = a `Policy` row existing, nothing more

New `PolicyType.GEOFENCE_BOUNDARY` (`src/modules/policy/entities/policy-type.enum.ts`),
org-unit-scoped, `definition: {centerLatitude, centerLongitude,
radiusMeters, enforcement: 'soft'|'hard'}`. No row for a given org unit =
geofencing inactive there. No new entity, no new tenant-level boolean —
this IS the opt-in mechanism, confirmed against the platform's own
existing convention: every prior `PolicyType` value is configured through
the same generic, already-shipped `POST /v1/policies`
(`CreatePolicyDto`'s `@IsIn(Object.values(PolicyType))`), so
`GEOFENCE_BOUNDARY` needs zero new admin tooling.

`core.policies`' `policies_type_check` CHECK constraint replaces its
entire allowed-value list on every migration rather than adding to it
(the same trap `1700000011000-PoliciesTypeCheckConsolidationFix.ts`
exists to fix) — a new migration
(`1700000012000-PoliciesTypeCheckAddGeofenceBoundary.ts`) was required to
extend it with the full accumulated list, not just the TS enum change.

**No separate tenant-level kill switch.** `core.policies` has no DELETE
grant and no "close a lineage" verb — disabling geofencing tenant-wide
means superseding every org unit's row individually. Named as a disclosed
gap, not solved: building a redundant boolean now would be exactly the
kind of speculative generality this module has declined before
(ADR-0154's `employeeId -> userId` resolution folded inline rather than
exposed as its own RPC, for the same reason).

### 2. `GET /v1/mobile/geofence-config` never returns the boundary's center

`mobile-ess-service`'s new `GeofenceVerificationService`
(`src/geofence/geofence-verification.service.ts`) resolves employeeId →
orgUnitId (`EmployeeService.GetEmployeeOrgUnits`, a second, independent
consumer of the RPC ADR-0099 built) → active `geofence_boundary` policy
for that org unit (`PolicyService.GetActivePolicy` — this service's
first cross-service consumer of that already-live RPC). The mobile app's
own read path (`getConfigForEmployee`) returns only `{enabled,
radiusMeters, enforcement}` — never the center coordinates. Actual
verification always happens server-side
(`GeofenceVerificationService.evaluate`, called from
`mobile-sync.service.ts`'s `processClockEvent`), never client-side — the
app has no way to compute or fake a "within bounds" result on its own.

**Fails open** on either gRPC call being unreachable, or on a malformed
policy `definition` (missing/non-numeric `radiusMeters`, etc.) — logged,
treated as not-enabled. Deliberately diverges from
`AttendanceExceptionDetectionService`'s own precedent (which fails closed
on its `ScheduleServiceClient` call, blocking ingestion): geofencing is
opt-in, and a transient infra hiccup must never turn an ordinary clock-in
into a blocked or failed one — the same philosophy that already governs a
real out-of-bounds clock-in under soft enforcement should extend to
infrastructure failures too.

### 3. Raw location is never persisted — computed once, in memory, then discarded

Reading `mobile-sync.service.ts`'s `processAction()` directly confirmed
`payload: action.payload` was persisted verbatim at row-insert time for
every action type. A location field added to the `clock_event` payload
without a fix would have leaked raw GPS coordinates into
`OfflineActionQueue.payload`'s jsonb column indefinitely (the table's own
established never-hard-delete posture, ADR-0151). Fixed by stripping
`location` from the payload object before it's ever passed to
`repo.create(...)`, threading the raw coordinates through
`processByActionType`/`processClockEvent` as a separate, transient
parameter used exactly once (the haversine-distance check against the
resolved boundary) and never written to any column, table, or log.

This is the strongest possible form of the spec's own retention
citation ("retained only as long as needed... not indefinitely") — a
zero-length retention window, achieved by never storing the raw value at
all rather than storing-then-purging on a schedule. No new column, no new
TTL cron this phase. A future phase adding real supervisor-facing
exception-review UI that needs to show *where* a flagged clock-in
happened should add location storage and its own retention cron
together, driven by that phase's real requirement — not guessed here.

### 4. Enforcement: hard mode never reaches attendance-leave-service

Soft enforcement (default): the computed `geofenceVerified` (`true` /
`false` / `null` when not enabled) is threaded into
`AttendanceClockEventClient.forward()`'s request (a new field, included
in the HMAC-signed body — transparent to the guard, which hashes raw
bytes) and recorded as-is on `AttendanceRecord.geofenceVerified`
(`attendance-leave-service` never recomputes it — "each service owns what
it owns," mobile-ess-service already did the real lookup).

Hard enforcement, out-of-bounds: `mobile-ess-service` short-circuits
*before* ever calling `AttendanceClockEventClient.forward()` — it already
has everything needed (the boundary + the computed distance) to decide
this locally, the same way it already decides `failed` vs `conflict`
today without attendance-leave-service's help. Throws a new
`ClockEventGeofenceViolationError`, mapped to `conflict` (ADR-0153's own
rule: this exact location will never succeed unmodified — a true
conflict, not a retryable `failed`). attendance-leave-service never
receives the request at all for this outcome; zero change was needed
there for hard enforcement.

### 5. Decline-is-unverified: the one genuinely security-relevant call

If the employee declines the OS location permission (or capture fails
for any other reason), `GeofenceVerificationService.evaluate` computes
`verified: false` — treated identically to a real out-of-bounds location,
enforcement proceeds accordingly, including hard enforcement if
configured.

Server-side, a declined-permission clock-in and a real out-of-bounds one
are technically indistinguishable — both arrive with no location. Letting
an employee's permission decision silently downgrade a tenant's
configured hard enforcement to soft would be a real, undetectable
security gap: a hard-enforcement tenant exists specifically because it
wants out-of-bounds clock-ins blocked, and "just don't grant the
permission" cannot be allowed to quietly defeat that. The mobile app's
own disclosure gate (`useGeofenceGate`) marks the disclosure acknowledged
regardless of the permission outcome — declining is a legitimate,
respected choice that simply means every subsequent clock-in is treated
as unverified, not a dead end and not silently ignored.

### 6. Exception flagging inherits the existing single-column limitation, verbatim

New `AttendanceExceptionType.GEOFENCE_VIOLATION`. `attendance_record`'s
`exception_type` CHECK constraint lists allowed values explicitly (same
replace-not-extend trap as `policies_type_check`) — a new migration
(`1700001000000-AttendanceRecordGeofenceVerified.ts`) drops and recreates
it alongside the new `geofence_verified` column, in one file per this
service's own "one migration per phase" convention.

`AttendanceIngestionService.ingest()` sets `exceptionType =
GEOFENCE_VIOLATION` only when no other anomaly was already detected —
inheriting `AttendanceExceptionDetectionService`'s own already-disclosed
"first anomaly wins, single column" limitation verbatim, not solved here.
The clock-out branch additionally guards on `openRecord.exceptionType`
already being set (not just the freshly-resolved value), since
`detectForClockOut` already short-circuits once a record carries an
exception and the existing `?? openRecord.exceptionType` fallback would
otherwise let a geofence flag silently clobber an already-real
LATE/UNSCHEDULED_WORK exception from clock-in.

`AttendanceRecord.geofenceVerified` on clock-out preserves the record's
existing value when the clock-out event itself carries no meaningful
result (`event.geofenceVerified ?? openRecord.geofenceVerified`, not `??
null`) — the same preserve-old-value-on-null pattern already used for
`exceptionType`/`exceptionMinutes`, so a transient fail-open at
clock-out time can't erase a real verification already recorded at
clock-in.

## Consequences

- Geofencing applies symmetrically to both `clock_in` and `clock_out` —
  there is no separate "online" code path in the mobile app to
  special-case just one direction (`queueClockEvent()` is one function
  for both), and the spec's own §5b heading ("clock-in verification")
  doesn't reflect an actual code-path distinction worth introducing.
- A tenant cannot bulk-disable geofencing without superseding every
  configured org unit's `Policy` row individually — disclosed, not fixed
  (§1).
- Supervisor exception review will be able to see *that* a clock-in was
  flagged `geofence_violation`, but not *where* it actually happened — no
  raw location is retained anywhere server-side (§3). No supervisor-
  facing UI for this exists yet in any module; `Alert`
  (`intraday-service`) has no `employeeId` column and was confirmed not
  to fit, so this phase deliberately doesn't force a fit.
- Declining the location permission under a hard-enforcement tenant means
  every subsequent clock-in is treated as an unverified conflict — a real
  UX consequence of §5's security reasoning, worth surfacing clearly in
  the (still-placeholder, legal-review-pending) disclosure copy once that
  copy is written.
