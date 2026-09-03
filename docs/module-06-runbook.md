# Module 06 Runbook — Attendance & Leave Management

Operational reference for `attendance-leave-service` (Phases 1-8). Every
check below is a direct SQL query against `attendance_leave.*` (any role
with `SELECT` - `agno_migrator` locally, since RLS's `ENABLE`-not-`FORCE`
posture means only the table owner sees cross-tenant rows), a
`redis-cli`/NATS check, or a scrape of the one `/metrics` endpoint
(`GET :8300/metrics`) - see `observability/grafana-dashboard-module-06.json`
for the panelled view of the same data.

## 0. One process, five external dependencies

`node dist/src/main.js` runs the HTTP API, the gRPC server
(`LeaveService.GetUnavailability`, Phase 5), and both `@Cron` jobs
(`LeaveCarryoverJobService` at 03:00 UTC, Phase 7;
`AbsencePatternDetectionJob` at 04:00 UTC, Phase 8) in one process - there
is no separate worker to start or scale independently. Five external
dependencies, all optional in the sense that this service starts without
them but individual features degrade or fail closed:

| Dependency | Used by | Failure mode |
|---|---|---|
| Postgres (`agno_wfm`, `attendance_leave` schema) | everything | hard failure - nothing in this service works without it |
| Redis | BullMQ approval-reminder queue (Phase 4) | best-effort - `requestLeave`/`decideLeaveRequest` still succeed, reminders silently don't schedule/cancel (logged as `WARN`) |
| NATS/JetStream | `agno.leave.request.approved.v1` publish (Phase 5) | best-effort - `decideLeaveRequest` still succeeds, scheduling-service's pull path (`GetUnavailability`) is unaffected |
| scheduling-service (REST, `SCHEDULING_SERVICE_URL`) | conflict-check pipeline (Phase 2/3) | **fails closed** - `requestLeave`/`submitBackdatedLeave` throw `UPSTREAM_UNAVAILABLE` (503), no write happens |
| core gRPC (`CORE_GRPC_URL`) | `AuditService.RecordEvent` (Phase 6, backdated decisions only), `CalendarService.GetWorkingTimeRules` (Phase 8, `pre_post_holiday` step only) | both best-effort/isolated - a backdated decision still commits if the audit call fails (logged `ERROR`, counted); one tenant's holiday-step failure doesn't block other tenants or the other two detection steps |

`GET /healthz` is pure liveness. `GET /readyz` checks Postgres only (this
service's design never made Redis/NATS/gRPC dependencies part of
readiness - see each phase's own design doc for why each was judged
best-effort rather than fail-closed).

## 1. requestLeave / submitBackdatedLeave failing with UPSTREAM_UNAVAILABLE

§2.2 rule 2's fail-closed conflict check (Phase 2/3, `ScheduleServiceClient`)
- `scheduling-service` is unreachable or erroring. Confirm:
`curl $SCHEDULING_SERVICE_URL/healthz`. This is by design, not a bug -
`conflict_flags` must be populated synchronously before any write, and a
degraded/silent conflict check would let a leave request through that
Module 04 never actually cleared. No retry/queue exists on this path;
the client must resubmit once scheduling-service recovers.

## 2. A leave request is stuck `pending` with no reminder firing

Check `curl :8300/metrics | grep leave_approval_reminders_fired_total` and
`redis-cli -p 6379 keys 'bull:leave-approval-reminders:*'` for the job.
Two independent, both-benign causes to rule out in order:

1. **Redis was down at submission time** - `LeaveApprovalQueueService.scheduleReminder`
   is best-effort (Phase 4's own doc comment); a failure is logged as
   `WARN "Failed to schedule approval reminder"` and swallowed. No
   reminder was ever queued - this is not recoverable after the fact
   without manually re-queuing.
2. **The request was already decided** - `LeaveApprovalReminderWorker`
   re-checks `LeaveRequest.status === PENDING` before firing anything
   (Phase 4's own correctness fix for the missed-cancel case); a reminder
   for an already-decided request fires *nothing* observable, by design.

If neither applies and the request is genuinely still pending with no
reminder, check `LEAVE_APPROVAL_REMINDER_DELAY_MS` - the default (10
minutes) is explicitly a local-dev placeholder (Phase 4's own doc
comment), not a considered production SLA.

## 3. A backdated leave decision - permission denials and audit gaps

`decideLeaveRequest` on an `is_backdated` request:
```sql
SELECT id, status, is_backdated, backdated_approved_by
FROM attendance_leave.leave_request
WHERE id = '<id>';
```
- **`403 INSUFFICIENT_PERMISSION`** on approval: the caller's
  `actorPermissions` array didn't include `backdated_leave_entry:approve`
  (client-supplied, unverified - Phase 6/ADR-0079's own explicit
  assumption; there is no real RBAC enforcement in this service).
  Rejecting a backdated request never needs this permission.
- **Audit gap**: `curl :8300/metrics | grep leave_backdated_audit_events_total` -
  a `result="failed"` count means `AuditService.RecordEvent` calls to
  core are failing (`CORE_GRPC_URL` unreachable, or core itself down).
  The decision itself already committed either way (Postgres is
  authoritative, ADR-0079) - a failed audit call is a compliance-record
  gap, not a data-correctness one. Cross-check against core directly:
  `SELECT * FROM core.audit_log WHERE resource_type = 'leave_request' AND resource_id = '<id>';`
  (allow up to ~2s after the decision for `AuditEventBatcherService`'s own
  flush cron, ADR-0042).

## 4. Carryover rollover/expiry - LeaveBalance looks wrong after a period boundary

`curl :8300/metrics | grep leave_carryover` for run outcomes. Direct
inspection:
```sql
SELECT period_start, period_end, accrued_days, used_days, pending_days,
       carryover_days_in, carryover_expiry_date, carryover_applied
FROM attendance_leave.leave_balance
WHERE employee_id = '<employee_id>' AND leave_type_id = '<leave_type_id>'
ORDER BY period_start;
```
- **A successor period never got its carryover** (`carryover_applied =
  false` well past its `period_start`): either its predecessor period
  hasn't closed yet (`period_end >= CURRENT_DATE` - correct, not a bug),
  or no predecessor row exists at all for that employee/leave-type/date
  range (this module doesn't generate new-period `LeaveBalance` rows -
  Phase 7's own explicit assumption; something else must create the row
  before rollover can add carryover to it).
- **A carryover amount looks capped lower than expected, or absent
  entirely**: check `leave_type.carryover_rules` - `{}` or a malformed
  `maxCarryoverDays` (non-numeric) both correctly resolve to zero
  carryover, not an error (ADR-0080's regex-guard reasoning).
- **A carryover that was just granted immediately shows
  `carryover_days_in = 0` again on the same day**: not a bug - if the
  rollover job is badly backlogged, a freshly-computed `carryover_expiry_date`
  can already be in the past, and the expiry step (same tick, runs
  second) correctly claws it straight back. See ADR-0080's own reasoning
  for why this is the correct outcome of an operational delay, not
  something to "fix" by extending the expiry.
- Both steps are idempotent single SQL statements (`carryover_applied`/
  `carryover_days_in > 0` are the completion markers) - safe to
  investigate without worrying about re-running causing double-application;
  there is no separate resume-cursor state to reconcile.

## 5. Absence pattern detection - nothing showing up, or the wrong tenant's holidays

`curl :8300/metrics | grep absence_pattern_detection_runs_total` (by
`step`/`result`) and `curl :8300/metrics | grep absence_patterns_detected_total`
(by `pattern_type`).

- **`frequency_threshold`/`recurring_day_of_week` showing `error`**: a
  Postgres-level failure in the cross-tenant SQL itself (check logs for
  `"Absence pattern detection (...) failed:"`) - these two steps have no
  external dependency, so an error here is a real Postgres problem, not a
  degraded-dependency situation.
- **`pre_post_holiday` showing `error` for specific tenants only**: that
  tenant's `CalendarService.GetWorkingTimeRules` call failed (core
  unreachable, or `CORE_GRPC_URL` misconfigured) - other tenants still
  get processed in the same tick (per-tenant fault isolation, Phase 8's
  own design). Check logs for `"...failed for tenant <id>:"`.
- **A pattern you expect isn't detected**: first check
  `idx_absence_pattern_tenant_unacknowledged` directly -
  `SELECT * FROM attendance_leave.absence_pattern WHERE employee_id = '<id>' AND pattern_type = '<type>' AND acknowledged_by IS NULL;`.
  If a row already exists, the dedup gate (§2.2 rule 4) is correctly
  suppressing a duplicate - acknowledge it
  (`POST /v1/leave/absence-patterns/<id>/acknowledge`) to let the next
  tick re-evaluate fresh. If no row exists and none is expected, check
  the relevant threshold env var
  (`ABSENCE_PATTERN_{FREQUENCY,RECURRING,HOLIDAY}_*`) against the actual
  data - all three formulas are documented in
  `absence-pattern-detection.job.ts`'s own doc comment and ADR-0081.
- **A pattern involving a holiday-adjacent *future*-dated request isn't
  detected**: confirm the tenant's `WorkingTimeCalendar.holiday_dates`
  actually includes that holiday - the calendar-lookup window is
  `today ± ABSENCE_PATTERN_HOLIDAY_WINDOW_DAYS` (symmetric, a real bug
  fixed during Phase 8's own verification, see that phase's production
  readiness checklist) - a holiday further out than the window on either
  side is correctly not considered.

## 6. Migration rollback

Every migration in `src/database/migrations/` has a real `down()`. Phases
1-3 added tables/FKs; Phase 7 added one column + one partial index; Phase
8 added no schema at all (the `absence_pattern` table has been correct
and unused since Phase 1). All are additive-only - reverting the most
recent one (`npm run migration:revert`) is safe in isolation.

## Standing gaps this runbook does not paper over

**No real tenant/actor authentication anywhere in this service** -
`X-Tenant-Id` is trusted as-is (header-trust placeholder since Phase 1),
and every actor-identifying field (`employeeId`, `decidedBy`,
`acknowledgedBy`, and Phase 6's `actorPermissions`) is client-supplied and
unverified. This is the same class of gap the root app closed once
(ADR-0014 → ADR-0049) and scheduling-service/intraday-service have also
left open. Anyone who can reach this service's port can claim any tenant
or any actor identity, including the elevated
`backdated_leave_entry:approve` permission.

**No real notification-delivery pipeline** - flagged independently in
Phase 4 (approval reminders), Phase 7 (expiring carryover), and Phase 8
(detected absence patterns). Module 01's `NotificationPreference` is a
preferences table with no send mechanism behind it anywhere in this
platform. All three features emit real, correct *signals* (BullMQ jobs,
Prometheus counters, `AbsencePattern` rows) with no real delivery on top.

**No accrual-rate / new-period `LeaveBalance` generation** (Phase 7) -
this module has never computed a base accrual amount or created a new
period's balance row from scratch; carryover only adds to a
already-existing successor row. A real HR accrual-rate engine (likely
needing Module 02's `EmploymentPolicy`) is a distinct, unbuilt feature.

**`no_show` absence-pattern detection** (Phase 1/5/8) - not one of
`AbsencePatternType`'s three schema-level values. Would need a proactive
scheduled-shift-vs-no-clock-in sweep, a materially different feature from
detecting a pattern across already-recorded data.

**No org-coverage conflict check** (Phase 3, ADR-0076) - Module 02 has no
minimum-staffing/org-coverage capability anywhere in its own gRPC surface
to call. `conflict_flags.orgCoverage` is always `null` ("not evaluated"),
never a fabricated true/false.

**No GraphQL surface** - every mutation across all 8 phases shipped REST-
first; no phase ever needed GraphQL enough to trigger building it.

**No consumer of `agno.leave.request.approved.v1`** (Phase 5) - the event
is produced and schema-documented (ADR-0078); nothing in this platform
subscribes to it. scheduling-service's own correctness never depended on
it (the pull path, `GetUnavailability`, is unconditionally correct on its
own).

See each phase's own production readiness checklist
(`docs/module-06-phase-{1..8}-production-readiness-checklist.md`) for the
complete, phase-by-phase categorized list this summary draws from.
