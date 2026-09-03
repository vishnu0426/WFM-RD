# Module 06 Phase 3 Design Doc — Attendance & Leave Management: Leave Request + Synchronous Conflict Check

**Status:** Approved for implementation
**Owner:** Attendance & Leave pod (Module 06), same as Phases 1/2. This
phase's real decisions - the Module02 org-coverage gap (ADR-0076) and the
row-lock ordering (ADR-0074, written in Phase 1, implemented here) - are
both about being honest and correct under a real constraint, not new
subsystem risk.
**Scope:** `POST /v1/leave/requests` (§3.2) / the `LeaveRequestService`
behind it: input validation, backdated-date rejection (§5.1, redirecting
to `submitBackdatedLeave` - not built until Phase 6), the synchronous
conflict-check pipeline (§4.4, §2.2 rule 2), and the concurrency-safe
`pending_days` reservation (§2.2 rule 1, ADR-0074) with its dedicated
concurrency test (§6). **Does not build** `decideLeaveRequest`, the
approval-chain workflow, or any `pending_days` → `used_days` transition
(Phase 4); does not build `LeaveService.GetUnavailability`/
`CheckScheduleConflict` or the NATS publish (Phase 5); does not build
`submitBackdatedLeave` (Phase 6); does not add GraphQL (introduced
whenever a phase first needs it - REST is this phase's only surface, same
posture Phase 2 took for attendance ingestion).

## Problem

Phase 1 shaped `LeaveBalance`'s composite PK specifically so this phase's
row lock would have a target (ADR-0074) and `LeaveRequest.conflict_flags`
specifically so this phase could populate it truthfully. Three things
needed settling before writing the submission path itself:

1. **Module02 has no org-coverage capability at all.** §4.4 names two
   synchronous checks - Module04 schedule conflicts and Module02 org
   coverage. Module04's side has a real, working precedent from Phase 2
   (`ScheduleServiceClient`). Module02's side does not exist: every proto
   Module02 exposes was read in full, and none of them - nor Module02's
   own schema - has any "minimum coverage" or "staffing threshold"
   concept. This is a bigger gap than Module04's leave-data gap was
   (ADR-0059) - there, a real table existed without a read endpoint; here,
   no data model exists at all. See ADR-0076.
2. **Phase 1's own migration missed a same-schema foreign key.**
   `leave_balance.leave_type_id`/`leave_request.leave_type_id` reference
   `leave_type`, which this same schema/migration owns - the exact
   "same-schema, real FK" case ADR-0075 later established for
   `attendance_ingestion_event.attendance_record_id`. Phase 1 treated it
   like a cross-module id (no FK) by oversight. Caught during this phase's
   own design review, fixed additively (`1700000800000-LeaveTypeForeignKeys.ts`
   - never editing an already-applied migration), not silently left as
   inconsistent precedent for this module's own established convention.
3. **§6's dedicated concurrency test needs a real Postgres, not a mocked
   `EntityManager`.** Phase 1/2's unit tests mock `DataSource.transaction`
   - sufficient for control-flow assertions, structurally incapable of
   proving `SELECT ... FOR UPDATE` actually serializes two genuinely
   concurrent submissions. This phase adds `test/integration/` (Phase 1's
   design doc flagged this as a real, deferred gap - this is the phase
   that closes it, because this is the first phase whose correctness
   claim depends on it).

## Decision

**Validation** (`LeaveRequestService.requestLeave`): `dateRangeEnd >=
dateRangeStart` (fails fast, `InvalidLeaveRequestError`, `400`) and
`dateRangeStart` not before today - UTC calendar date, computed
server-side, never client-supplied (§5.1's "derive it" instruction, same
spirit even though `is_backdated` itself is Phase 6 scope). A submission
that fails the second check is rejected outright
(`BackdatedLeaveNotSupportedError`, `400`) rather than silently accepted
with `is_backdated: true` - `submitBackdatedLeave` doesn't exist yet
(Phase 6), so there is currently no way to submit backdated leave through
this service at all, and that is the correct, honest state until Phase 6
ships, not a gap to paper over.

**Conflict check** (`LeaveConflictCheckService`, ADR-0076): calls
`ScheduleServiceClient.getShiftAssignments` (shared with `AttendanceModule`
- moved to `src/common/scheduling/` this phase, since ADR-0039's "own copy
per service" precedent is about not sharing a client *across* services,
not duplicating it within one service's submodules) for the request's date
range, flags `scheduleConflict.hasConflict` if any returned assignment
overlaps it. `orgCoverage` is always `null` (ADR-0076). A
`scheduling-service` failure throws `UpstreamUnavailableError` (`503`) -
fails closed, per §2.2 rule 2 - and happens *before* `LeaveRequestService`
opens any transaction.

**Balance reservation** (`LeaveRequestService.reserveAndSubmit`, ADR-0074):
`withTenantConnection` opens one transaction; `SELECT ... FOR UPDATE` (via
TypeORM's `setLock('pessimistic_write')`) on the `LeaveBalance` row whose
composite PK covers the request's employee/leave-type/date-range
(`periodStart <= dateRangeStart AND periodEnd >= dateRangeEnd` - a request
spanning two balance periods is out of scope this phase, see explicit
assumptions). No matching row → `LeaveBalanceNotFoundError` (`404`),
fail-closed default (zero days available, never "unlimited"). `availableDays
= accruedDays - usedDays - pendingDays`, computed from the locked read.
`requestedDays` (inclusive whole-day count, no half-days this phase) `>
availableDays` → `InsufficientLeaveBalanceError` (`409`). Otherwise:
`manager.increment(LeaveBalance, ..., 'pendingDays', requestedDays)`
(parameterized `SET pending_days = pending_days + $1`, not string-built
SQL) then `LeaveRequest` insert (`status: pending`, `approvalChainId:
null` - Phase 4 assigns it), same transaction.

**No separate `leave_type_id` existence check or error class.** An earlier
version of this method caught the new FK's violation on insert and
re-surfaced it as a dedicated `LeaveTypeNotFoundError`. Real-Postgres
verification (below) showed that path can never actually be reached: the
balance lookup is keyed by `leaveTypeId`, so an id with no matching
`LeaveBalance` row always hits `LeaveBalanceNotFoundError` first, and any
row that *does* exist already has a FK-validated `leaveTypeId` (the
Phase 3 migration's FK is checked at the time that row is created). Kept
as dead code with a passing unit test, this would have misrepresented an
unreachable path as tested behavior - removed instead. The FK constraint
itself remains, as real integrity insurance for any future write path
that skips this lookup.

**Where `LeaveBalance` rows come from**: nowhere in this module's owned
mutation surface (§3.1 lists no `createLeaveBalance`/accrual mutation).
This phase only reads and increments `pending_days` on rows that already
exist - see explicit assumption 3.

## Blast radius

- New files under `attendance-leave-service/src/leave/` (conflict-check
  service, request service, controller, module, DTO) and
  `src/common/errors/` (four new `DomainError` subclasses). One new
  additive migration (`1700000800000-LeaveTypeForeignKeys.ts`).
  `src/attendance/schedule-service-client.ts` moves to
  `src/common/scheduling/` (import-path change in `AttendanceModule`/
  `AttendanceExceptionDetectionService` only - no behavior change).
- `app.module.ts` gains one import (`LeaveModule`); `MetricsService` gains
  two metrics; `DomainErrorFilter` gains four status mappings. All
  additive - every Phase 1/2 route, metric, and mapping is unchanged.
- New `test/integration/` directory (didn't exist before this phase),
  `test/jest-integration.json`, and a `test:integration` package.json
  script - mirrors root `src/`'s existing convention exactly.
- No Module 01–05 file touched. No change to `scripts/init-roles.sql` or
  `observability/prometheus.yml` this phase (Phase 1/2's role/schema/
  scrape-target setup already covers this phase's needs).

## Rollback plan

Revert `LeaveModule`'s import in `app.module.ts`, delete `src/leave/`
service/controller files (keep the Phase 1 entities), revert
`1700000800000-LeaveTypeForeignKeys.ts` (`DROP CONSTRAINT`/`DROP INDEX`,
all `IF EXISTS`-guarded - safe, single-migration-scoped, doesn't touch the
`migration:revert`-to-zero gap Phase 1 flagged), move
`schedule-service-client.ts` back under `attendance/` if strict Phase 2
parity is wanted (not required - Phase 2's own behavior is unaffected by
the move). Nothing external calls `POST /v1/leave/requests` yet outside
manual verification, so rollback is a non-event now.

Verified against a real local Postgres, not just unit tests and the
integration test: both Phase 3 migrations apply cleanly on top of
Phase 1/2's, and `POST /v1/leave/requests` was exercised over real HTTP
against the built app (with a stub `scheduling-service` returning no
assignments) for the accepted, insufficient-balance, backdated-rejection,
invalid-date-range, and no-balance-row (both an unknown `leaveTypeId` and
an unknown `employeeId`) cases. That last check is what surfaced the
`LeaveTypeNotFoundError` dead-code finding described above - the "unknown
leaveTypeId" case returned `LEAVE_BALANCE_NOT_FOUND`, never
`LEAVE_TYPE_NOT_FOUND`, in every real request, confirming the FK-violation
catch could never fire in practice.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`employeeId` is accepted in the request body, not derived from an
   authenticated session.** This platform's auth/identity headers are
   still the header-trust placeholder (ADR-0014) throughout every service,
   with no concept yet of "the calling user" distinct from "the tenant" in
   this service. A real implementation would need to decide whether
   `requestLeave` is self-service-only (employeeId = the caller) or also
   supervisor-initiated (explicit employeeId, permission-checked) - that
   decision needs real identity plumbing this phase doesn't have. Accepting
   an explicit `employeeId` field keeps this phase functional and honest
   about the gap rather than guessing at an auth model.
2. **A request spanning more than one `LeaveBalance` period is rejected
   (`LeaveBalanceNotFoundError`), not merged across periods.** §2.1 doesn't
   describe cross-period requests at all. Merging would mean partially
   reserving from two rows under two separate locks - real added
   complexity (multi-row lock ordering, partial-failure semantics) for a
   case the module prompt never asks for. A future phase can add it
   explicitly if a real need appears.
3. **`LeaveBalance` row provisioning (the initial `accrued_days` an
   employee has) is out of this module's owned mutation surface entirely.**
   §3.1 lists no create/accrual mutation for `LeaveBalance`, and no phase
   in §7's build list is assigned "populate accrued_days" (Phase 7 only
   manages `carryover_days_in`/expiry, a different, additive column). This
   phase treats `LeaveBalance` rows as provisioned by some other means
   (data import, a future accrual job, or a Module 02/Module 12 process) -
   `requestLeave` against a balance that doesn't exist is rejected, not
   auto-created with an assumed value.
4. **No half-day/partial-day leave.** `requestedDays` is always a whole
   inclusive day count between `dateRangeStart`/`dateRangeEnd`. Nothing in
   §2.1's schema (both are `date` columns) suggests otherwise; introducing
   fractional days would need a schema change, not an application-layer
   guess.
5. **Numeric balance arithmetic uses plain JS numbers, not a decimal
   library.** `LeaveBalance`'s numeric columns are `precision: 6, scale: 2`
   - small, bounded magnitudes where floating-point error is not a
   realistic concern at this phase's scope. Flagged rather than silently
   assumed, since a future phase handling real payroll-adjacent
   aggregation at scale should reconsider this.

## Out of scope for this phase (do not build yet)

- `decideLeaveRequest`, the BullMQ approval-chain workflow,
  `pending_days` → `used_days` transition on approval - Phase 4.
- `LeaveService.GetUnavailability`/`CheckScheduleConflict` gRPC/REST
  surface for Module 04, the `agno.leave.request.approved.v1` NATS
  publish - Phase 5.
- `submitBackdatedLeave`, the elevated backdated-leave permission - Phase 6.
- Carryover/expiry rollover jobs - Phase 7.
- `AbsencePattern` detection, GraphQL, dashboards/runbooks - Phase 8 /
  whichever phase first needs GraphQL.
- Any real Module02 org-coverage capability - not this module's to build;
  see ADR-0076.
- `LeaveBalance` accrual/provisioning - see explicit assumption 3.
