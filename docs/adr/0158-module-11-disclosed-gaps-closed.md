# ADR-0158: Close Module 11's three remaining self-contained disclosed gaps

## Context

Three of Module 11's own phases shipped with a named, deliberately-deferred
gap rather than a silent workaround: ADR-0155 disclosed that a geofencing
policy, once enabled, had no way to be turned back off short of a confusing
zero-radius replacement version; ADR-0154 disclosed that `DeviceRegistration`'s
`(tenant_id, employee_id, device_type)` key meant a second same-platform
device silently overwrote the first's push token, and that `quietHoursStart`/
`quietHoursEnd` were stored on `NotificationPreference` but never actually
checked. All three are self-contained to Module 11 (no cross-cutting auth
work, unlike [[0157-userid-employee-link-and-session-verified-employee-id]]),
so they're closed together here.

## Decision

**Gap 1 - geofencing kill-switch, generalized to every `PolicyType`.**
`PoliciesRepository.deactivate(policyGroupId)` closes a lineage's open
version at "now" with no successor inserted - reuses `supersede()`'s
lineage-closing mechanics, minus the insert. `PolicyManagementService.deactivate()`
fetches the open version first (to know its `orgUnitId` for the ABAC check -
`deactivate` has no request-body `orgUnitId` to read, unlike `createOrVersion`),
then applies the same `policy:write`-for-that-org-unit gate. `POST /v1/policies/:policyGroupId/deactivate`
on `PolicyManagementController`, same audit-log posture as `create`. Built on
the existing `Policy` abstraction rather than a geofencing-specific flag, so
every `PolicyType` gets a real off switch, not just geofencing.

**Gap 2 - multi-device push.** `device_registration` gains a `device_id`
column (migration `1700009700000-DeviceRegistrationDeviceId`), and the
unique constraint widens from `(tenant_id, employee_id, device_type)` to
`(tenant_id, employee_id, device_type, device_id)`. `RegisterDeviceRequestDto`
gains a required `deviceId`; `DevicesService.register()`'s
find/create/race-retry paths all key on the 4-tuple now.
`mobile-app/src/lib/deviceId.ts`'s `getOrCreateDeviceId()` already existed
(minting a stable per-install id, previously only sent to `syncOfflineActions`)
- `useRegisterDeviceOnAuth` now also sends it to `registerDevice`.
`PushDispatchService`'s fan-out loop needed no change - it already iterates
every row `findActiveForEmployee` returns, which is now correctly two rows
for an employee with two devices instead of one row silently clobbered by
the second registration.

**Gap 4 - quiet hours, enforced.** `NotificationPreferenceGrpcController.isPushEnabled`
now checks, when a matched preference has both `quietHoursStart`/`quietHoursEnd`
set: resolve the employee's timezone in-process
(`employee.orgUnitId` -> `WorkingTimeCalendarsService.findForOrgUnit`, the
same primitive `CalendarGrpcController` already calls - no new gRPC hop),
compute "now" in that local time, and check whether it falls in
`[quietHoursStart, quietHoursEnd)`, including a window that wraps midnight
(e.g. `22:00` -> `07:00`). Returns `enabled: false` if so. Fails open on any
lookup/parse failure (missing calendar, unrecognized IANA zone name) -
`enabled: true`, send anyway - same posture ADR-0155 already established for
geofencing infra failures, and the same `safeZone` fallback-to-UTC pattern
`SkillDecaySchedulerService` already uses elsewhere in this codebase.

## Consequences

- Deactivating a geofencing policy does not un-verify past attendance
  records - `AttendanceRecord.geofenceVerified`/`GEOFENCE_VIOLATION` rows
  already written stay as they were; deactivation only affects future
  `GeofenceVerificationService.evaluate` calls, which will fail open (no
  active policy = not enabled) from that point on, same as an org unit that
  never enabled geofencing.
- `device_id NOT NULL` with no default and no backfill path - there is no
  pre-existing production data in this environment, so this migration
  assumes a fresh/dev database, same posture every other Module 11 migration
  in this session took ([[0157-userid-employee-link-and-session-verified-employee-id]]'s
  `EmployeesUserIdUniqueIndex`).
- Quiet hours suppress a send outright - there is no deferred-redelivery
  queue for a push notification blocked during quiet hours (named
  explicitly out of scope in the parent plan, not silently dropped). An
  employee who never opens the app during their quiet-hours window simply
  never receives that particular push.
- A preference row with only one of `quietHoursStart`/`quietHoursEnd` set
  (a partially-configured row, not achievable through any UI this platform
  currently ships) is treated as "no quiet hours configured" - both must be
  present for the check to run at all.
