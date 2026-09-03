# Module 06 Phase 2 Design Doc — Attendance & Leave Management: Attendance Ingestion

**Status:** Approved for implementation
**Owner:** Attendance & Leave pod (Module 06), same as Phase 1 - no
subsystem owner handoff, this phase's real decisions (idempotency
mechanism, ADR-0075; per-request RLS tenant binding, below) are direct,
documented consequences of Phase 1's own choices (no Redis until Phase 4;
a schema whose RLS policy Phase 1 shipped but no request path had yet
exercised), not a new subsystem risk.
**Scope:** `POST /v1/attendance/tenants/:tenantId/clock-events` (§3.2):
HMAC signature verification, Postgres-unique-constraint idempotency
(ADR-0075), `AttendanceRecord` writes for both `clock_in` (new row) and
`clock_out` (closes the employee's open row), and exception detection
against Module 04's actual `ShiftAssignment` data via `ScheduleServiceClient`
(§2.2 rule 3) producing `late`/`early_leave`/`unscheduled_work`. **Does not
build `no_show` detection** (needs a proactive sweep job, not an
event-driven check - see Out of scope), **does not touch any `Leave*`
table**, **does not add NATS, Redis, or BullMQ** (Phase 1's deferral holds
through this phase too - NATS arrives in Phase 5, BullMQ in Phase 4), and
**does not add GraphQL**.

## Problem

Phase 1 shaped `AttendanceRecord` and stated (§2.2 rule 3) that
`scheduled_shift_id` must link to a *real* `ShiftAssignment`, not a
scheduled/unscheduled boolean - this phase is where that linkage actually
gets populated, from real webhook traffic, for the first time. Two
decisions were worth settling deliberately rather than defaulting into:

1. **Idempotency mechanism.** §3.2 requires "idempotent per device-provided
   event id," the same requirement Module 05's Phase 1 ingestion endpoint
   faced. Module 05 answered it with a Redis lock, justified by Module 05's
   own throughput/system-of-record posture (ADR-0062). Module 06's Phase 1
   design doc already decided *not* to bring in Redis until Phase 4 - so
   this phase needed its own answer, not a copy-paste of Module 05's. See
   ADR-0075.
2. **A `clock_out` event doesn't create a row - it closes one.** Unlike
   Module 05's append-only activity-event stream (one row per event,
   always an insert), §2.1's `AttendanceRecord` carries both
   `clock_in_at`/`clock_out_at` on a single row. A `clock_out` webhook must
   correlate to the employee's currently-open record (`clock_out_at IS
   NULL`) and update it, or be rejected as orphaned - not silently
   fabricate a new record. This shapes both the service's control flow and
   what "duplicate" and "conflict" mean for this endpoint in a way Module
   05's ingestion service never had to reason about.
3. **Binding RLS's `app.current_tenant_id` GUC per request.** Phase 1
   shipped every table's RLS policy but exercised none of them from real
   application code - `HealthController`'s `SELECT 1` doesn't touch a
   tenant-scoped table. This phase is the first with an actual write path,
   and a plain `@InjectRepository` connection never sets that GUC, so RLS
   fails closed on every query. intraday-service solved this once already
   (`withTenantConnection`); this phase adopts the same fix rather than
   rediscovering it from scratch, but it *was* rediscovered the hard way -
   this service's own Phase 1 didn't carry the helper over because Phase 1
   had nothing to use it on yet.

## Decision

**Endpoint** (`src/attendance/attendance-ingestion.controller.ts`):
`POST /v1/attendance/tenants/:tenantId/clock-events`, `tenantId` a URL path
segment (explicit assumption 1 below), guarded by `HmacSignatureGuard` (own
copy of intraday-service's `t=<unix_ms>,v1=<hmac>` verifier, ADR-0046's
shape in reverse, `ATTENDANCE_WEBHOOK_SECRETS` env map per Phase 1's
established precedent for this exact class of decision). `202 Accepted` on
first sighting, `200 OK` on a dedup'd replay, `409 Conflict` on an orphaned
`clock_out` or a genuine concurrent-close race, `503` on a
`scheduling-service` outage encountered mid-processing.

**Idempotency** (`AttendanceIngestionService`, ADR-0075): a Postgres
`attendance_ingestion_event` table, unique on `(tenant_id, source,
source_event_id)` with a real FK to the `AttendanceRecord` it resulted in,
is the sole dedup mechanism - a unique-violation on insert *is* the
"already seen this" signal. The `AttendanceRecord` write (insert for
`clock_in`, update for `clock_out`) and the ledger insert run in **one
transaction**: a unique-violation rolls both back together, so there is
never a window where the two could diverge, and no manual compensating
action is needed. See ADR-0075's revision note for why this replaced an
earlier "insert the ledger row first, delete it on failure" design that
turned out to directly conflict with the FK.

**Tenant-scoped writes go through `withTenantConnection`**
(`src/database/with-tenant-connection.ts`, own copy of intraday-service's
helper): every read/write in `AttendanceIngestionService` runs
`SELECT set_config('app.current_tenant_id', $1, true)` at the start of its
own transaction, since RLS silently rejects (`INSERT`) or hides (`SELECT`/
`UPDATE`) anything issued through a plain `@InjectRepository` connection
with the GUC unset. Phase 1 never needed this (no request path existed
yet); this is the first phase that does, and it is not optional wiring -
both this and the FK-ordering issue above were caught by this phase's
real-Postgres verification, not by unit tests against mocked repositories.

**Exception detection** (`AttendanceExceptionDetectionService`, §2.2 rule 3):
calls `ScheduleServiceClient` (own copy of intraday's, ADR-0064's endpoint,
Phase 1's explicit-assumption-2 REST-not-gRPC decision) to fetch the
employee's real shift assignments around the clock event's timestamp.
- `clock_in`: no covering shift found → `unscheduled_work`,
  `scheduled_shift_id` stays `null`. A covering shift found but the clock-in
  is more than `ATTENDANCE_LATE_GRACE_MINUTES` past its start → `late`,
  `exception_minutes` = minutes late.
- `clock_out`: only evaluated if the record isn't already
  `unscheduled_work`/`late` (§2.1's single `exception_type` column can't
  carry two flags - see the service's own doc comment for the accepted
  trade-off). More than `ATTENDANCE_EARLY_LEAVE_GRACE_MINUTES` before the
  shift's end → `early_leave`.
- `no_show` is never produced by this path - see Out of scope.

**Grace-period thresholds** are flat env config
(`ATTENDANCE_LATE_GRACE_MINUTES`/`ATTENDANCE_EARLY_LEAVE_GRACE_MINUTES`,
default 10), not per-tenant/per-`EmploymentPolicy` - explicit assumption 3.

**Control flow ordering**: the `ScheduleServiceClient` HTTP call always
happens before the corresponding Postgres write, never inside a
transaction or held lock spanning it - the same principle ADR-0074 states
for Phase 3's leave-balance lock, restated here even though this path never
holds a row lock at all (a slow `scheduling-service` response should
never block anything beyond the one request making it).

## Blast radius

- New files only, entirely under `attendance-leave-service/src/attendance/`,
  plus one new migration, one new ADR, these two docs. No Module 01–05
  file touched.
- `app.module.ts` gains one import (`AttendanceModule`); `main.ts` gains
  `rawBody: true` on `NestFactory.create` (required for the HMAC guard,
  same as intraday's own `main.ts`) and an updated boot-log line. Both are
  small, additive, and were already anticipated by Phase 1's design doc
  ("each [module] lands with the phase that gives it something real to
  do").
- `MetricsService` gains two new metrics
  (`attendance_ingestion_events_total`, `attendance_ledger_insert_duration_seconds`);
  every Phase 1 metric is untouched.
- `.env.example` gains five new variables, all with defaults that let
  Phase 1's existing local-dev flow keep working unmodified.

## Rollback plan

Revert `AttendanceModule`'s import in `app.module.ts` and the `rawBody`
option in `main.ts`, delete `src/attendance/` down to Phase 1's entity-only
state (keep `attendance-record.entity.ts`, remove everything else added
this phase), revert the migration
(`DROP TABLE IF EXISTS attendance_leave.attendance_ingestion_event;` - a
single-table drop, not a whole-schema one, so this doesn't hit the
`migration:revert`-to-zero gap Phase 1's design doc flagged). Nothing
external calls this endpoint yet outside manual verification, so rollback
is a non-event now.

## Explicit assumptions (spec was ambiguous or silent here)

1. **The endpoint path is `/v1/attendance/tenants/:tenantId/clock-events`,
   not §3.2's literal `/v1/attendance/clock-events`.** Same structural need
   Module 05's Phase 1 already established and this module's own Phase 1
   design doc flagged as a precedent to reuse: `HmacSignatureGuard` must
   know which tenant's secret to verify against before it can verify
   anything, and a server-to-server badge/biometric webhook has no
   JWT/session to derive tenant identity from otherwise.
2. **An orphaned `clock_out` (no open `AttendanceRecord` for that employee)
   is rejected (`409`, `NoOpenAttendanceRecordError`), never fabricated.**
   The module prompt doesn't say what to do here; inventing a same-instant
   clock-in/clock-out record would create attendance data that never
   happened, directly against §0's compliance framing. A real fix (matching
   a genuinely late-arriving `clock_in` webhook, or flagging for manual
   correction) is real future work - not built this phase.
3. **Late/early-leave grace-period thresholds are flat env config, not
   per-tenant or per-`EmploymentPolicy`.** Module 02 owns
   `EmploymentPolicy` and could plausibly carry this as a real per-tenant
   value; wiring a gRPC/REST call to Module 02 for two integer thresholds
   is real scope this phase doesn't need to take on to deliver working
   exception detection. A future phase can move this to a per-tenant policy
   read without changing `AttendanceExceptionDetectionService`'s public
   shape.
4. **A record already flagged `late` at clock-in is never re-evaluated for
   `early_leave` at clock-out, and vice versa is structurally impossible
   (clock-in always runs first).** §2.1's schema has one `exception_type`
   column; this phase picks "first anomaly detected wins," not "worst
   anomaly wins" - simplest rule consistent with the given schema, flagged
   here rather than silently chosen. A future phase wanting both signals
   simultaneously would need a schema change (§2.1 itself, not something
   this phase should quietly work around).
5. **`no_show` is not detected in this phase.** Every other exception type
   here is triggered by an event arriving; `no_show` requires detecting
   the *absence* of one (a shift ended with nothing to compare against) -
   structurally a proactive sweep job (`@Cron`), not something this
   ingestion path can produce. Not assigned to a specific later phase by
   the module prompt; flagged as a real gap for whichever phase picks it up
   (most naturally alongside Phase 8's observability/hardening pass, or
   sooner if compliance reporting needs it earlier).

## Out of scope for this phase (do not build yet)

- `no_show` detection (a proactive sweep job) - see assumption 5.
- Manual correction of an orphaned/incorrect `AttendanceRecord` - no
  `recordClockEvent` GraphQL mutation (§3.1) or REST fallback for the
  manual-entry case exists yet; this phase is the badge/biometric webhook
  path only.
- Any `Leave*` table, `requestLeave`, conflict checks - Phase 3.
- BullMQ, NATS, Redis in any form - Phase 4/5 respectively, per Phase 1's
  own deferral.
- GraphQL (`attendanceExceptions` query, §3.1) - introduced alongside
  whichever phase first needs it.
- Per-tenant/per-`EmploymentPolicy` grace-period thresholds - see
  assumption 3.
- A durable per-tenant webhook secret store (same gap Module 05's Phase 1
  flagged and has not yet closed for itself either) - `ATTENDANCE_WEBHOOK_SECRETS`
  remains a local env-config stand-in.
