# Module 11 Phase 6 Design Doc — Geofencing (tenant opt-in)

**Status:** Approved for implementation
**Owner:** Mobile / Employee Self-Service pod (Module 11)
**Scope:** §5b's technical mechanism working end to end — tenant-opt-in
per-org-unit geofence boundary configuration, device location capture on
Clock In/Out gated behind a blocking disclosure, server-side verification,
soft-by-default exception flagging with an explicit hard-enforcement
option. No schema change to `OfflineActionQueue` —
`geofence_verified` has existed as a column since Phase 3, always `null`
until this phase; the only new migrations are `core.policies`' CHECK
constraint (one new `PolicyType` value) and `attendance_record`'s new
`geofence_verified` column + `exception_type` CHECK extension.

## Problem

No geofence/location infrastructure existed anywhere in the platform
before this phase. The spec asks for: default-off tenant opt-in,
per-org-unit boundary configuration, device location capture on every
clock event (online or offline), server-recorded verification result, and
soft-by-default exception flagging that only hard-blocks when a tenant
explicitly configures it. Two already-real, already-deployed platform
mechanisms turned out to fit almost exactly — `Policy`
(org-unit-scoped config, already exposed cross-service via
`PolicyService.GetActivePolicy`) and `EmployeeService.
GetEmployeeOrgUnits` (built in ADR-0099 to close exactly the
employeeId→orgUnitId gap this phase also needed) — so the real design
work was reuse, not invention, plus one genuinely new decision: what a
declined location permission should mean for enforcement.

## Decision

See docs/adr/0155 for full reasoning; summarized:

- New `PolicyType.GEOFENCE_BOUNDARY`, org-unit-scoped,
  `definition: {centerLatitude, centerLongitude, radiusMeters,
  enforcement: 'soft'|'hard'}`. No row for an org unit = geofencing
  inactive there — this IS the opt-in mechanism, configured through the
  same generic `POST /v1/policies` every other policy type already uses.
  No new admin UI/endpoint needed.
- `mobile-ess-service` gains its first two gRPC clients of any kind
  (`PolicyGrpcClientService`, `EmployeeGrpcClientService`, mirroring
  Phase 5's own `NotificationPreferenceGrpcClientService` template) and a
  new `GeofenceVerificationService` (`src/geofence/`) that resolves
  employeeId → orgUnitId → active boundary policy, fails open on any gRPC
  unavailability or malformed policy data, and never exposes the
  boundary's center coordinates to the mobile app — only
  `{enabled, radiusMeters, enforcement}`.
- Raw device coordinates are never persisted anywhere server-side.
  `mobile-sync.service.ts`'s `processAction()` was found to persist
  `payload` verbatim at insert time — fixed by stripping `location`
  before the row is created and threading it through as a transient,
  in-memory-only parameter used once (a haversine-distance check) and
  discarded. Zero-length retention window, by construction.
- Soft enforcement (default): the computed verification boolean is
  threaded into `AttendanceClockEventClient.forward()` and recorded as-is
  on a new `AttendanceRecord.geofenceVerified` column — attendance-leave-
  service never recomputes it. Hard enforcement: `mobile-ess-service`
  short-circuits before ever calling attendance-leave-service, returning
  a `conflict` (ADR-0153's rule: this exact location will never succeed
  unmodified) — zero attendance-leave-service change needed for this
  path.
- Declining the OS location permission is treated identically to a real
  out-of-bounds location (`verified: false`) — server-side the two are
  indistinguishable, and letting a permission decision silently downgrade
  a tenant's configured hard enforcement would be an undetectable
  security gap.
- New `AttendanceExceptionType.GEOFENCE_VIOLATION`, set only when no
  other exception was already detected — inheriting
  `AttendanceExceptionDetectionService`'s own already-disclosed
  single-column "first anomaly wins" limitation verbatim, both on
  clock-in and (with an added `openRecord.exceptionType` guard) clock-out.
- Mobile app: `expo-location` (foreground-only permission), a blocking
  disclosure card (`GeofenceDisclosureCard`) shown only when
  `GET /v1/mobile/geofence-config` reports the employee's org unit as
  active, mirroring `src/auth/biometric.ts`'s local-acknowledgment
  pattern. Location is captured once per clock-in/out tap, never a
  background trail.

## Blast radius

Additive across four codebases: root platform-core (one `PolicyType`
enum value + CHECK-constraint migration, no controller/RPC change),
`mobile-ess-service` (`src/geofence/`, two new gRPC clients, changes to
`mobile-sync.service.ts`/`attendance-clock-event-client.ts`),
`attendance-leave-service` (`AttendanceRecord`/`ClockEventDto`/
`AttendanceIngestionService` changes, one migration), `mobile-app`
(`src/geofence/`, `ClockInOutControls.tsx`, `storage.ts`/`clockEvent.ts`
payload widening). No existing endpoint's behavior changes for a tenant
that hasn't configured a `geofence_boundary` policy — `geofenceVerified`
stays `null` throughout, identical to every clock event before this
phase.

## Rollback plan

Revert `GeofenceModule`/the two new gRPC clients and the
`mobile-sync.service.ts`/`attendance-clock-event-client.ts` changes in
`mobile-ess-service`; revert `attendance-leave-service`'s entity/DTO/
ingestion-service changes and its migration; revert `mobile-app`'s
`src/geofence/` and `ClockInOutControls.tsx`'s wiring. The root
`PolicyType` enum value and its CHECK-constraint migration are harmless
to leave in place even if the rest is rolled back (an unused policy type
that nothing writes).

## Explicit assumptions (spec was ambiguous or silent here)

1. **No separate tenant-level kill switch** — a `Policy` row's existence
   is the entire opt-in mechanism; disabling tenant-wide means
   superseding every org unit's row individually. Disclosed, not solved.
2. **Raw location is never persisted, anywhere, ever** — not even
   short-term for a future supervisor-detail view. A future phase adding
   real exception-review UI should add storage + retention together,
   driven by that phase's real requirement.
3. **Fail-open on gRPC unavailability**, diverging deliberately from
   `AttendanceExceptionDetectionService`'s own fail-closed precedent —
   geofencing is opt-in, and infra hiccups must never block an ordinary
   clock-in.
4. **Decline-is-unverified** — a declined location permission is treated
   exactly like a real out-of-bounds location, including under hard
   enforcement. The one genuinely security-relevant decision in this
   phase.
5. **Geofencing applies to both clock_in and clock_out symmetrically** —
   there is no separate online/offline or clock-in-only code path in the
   mobile app to special-case.
6. **No native date/map UI** for visualizing the boundary — the mobile
   app never sees the center coordinates at all, so there was nothing to
   visualize even if desired.

## Out of scope for this phase

- Supervisor-facing UI for reviewing geofence exceptions (confirmed no
  existing per-employee Module 08 mechanism fits — `Alert` has no
  `employeeId` column).
- Legal/consent disclosure copy — the spec's own explicit non-goal; a
  clearly marked placeholder only.
- Location history/tracking beyond one transient capture per clock event.
- Background location (foreground-only permission).
- A tenant-facing policy-management UI — not a gap; every `PolicyType` is
  already configured through the same generic, already-shipped
  `POST /v1/policies`.
- A tenant-wide geofencing kill switch.
- Raw-location storage/retention cron — deferred to a future phase with a
  real UI need.

## Verification

- `npm run typecheck && npm test` (root) — one new enum value; no other
  core change (existing `PolicyGrpcController`/`PoliciesRepository`/
  `PolicyManagementController` are already generic over `PolicyType`).
- `cd mobile-ess-service && npm run lint && npm run typecheck && npm test`
  — 90 tests: haversine correctness, `GeofenceVerificationService`
  (not-enabled, verified, out-of-bounds, no-location, fails-open on
  either gRPC client, malformed-policy-fails-open), and dedicated
  `mobile-sync-geofence.spec.ts` coverage (location stripped from every
  persisted payload, hard enforcement never calls
  `attendanceClient.forward`, soft enforcement still forwards and
  records the result, decline-is-unverified propagation).
- `cd attendance-leave-service && npm run lint && npm run typecheck && npm test`
  — 126 tests: new migration spec, exception-flagging tests for both
  clock-in and clock-out (including the "already has an exception, don't
  overwrite" and "clock-out preserves clock-in's geofenceVerified when
  its own event carries none" cases), the pre-existing entity-parity
  regression test updated to include the new exception type.
- `cd mobile-app && npm run lint && npm run typecheck && npm test` — 47
  tests: gate state-machine tests (`ClockInOutControls.test.tsx` — not-
  enabled never shows the disclosure, acknowledging without OS permission
  still lets clock-in proceed without location, granted permission
  captures and queues real coordinates), using an explicit, narrow
  `expo-location` test mock (verified before writing tests against it
  that no jest-expo auto-mock exists for this module either, same class
  of gap Phase 4/5 already found for `expo-crypto`/`expo-notifications`).
  `npx expo export --platform web` bundle smoke test.
- Manual local run against real Postgres + a running scheduling-service +
  a real device with real GPS: not performed in this environment (no
  persistent multi-service runtime, no physical device here) — stated
  plainly rather than claimed, same as every prior phase.
