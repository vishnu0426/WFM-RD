# Module 06 Phase 1 Design Doc — Attendance & Leave Management: Schema & Migrations

**Status:** Approved for implementation
**Owner:** Attendance & Leave pod (Module 06) — no single-subsystem owner
the way Module 05's Redis/NATS write path needed a Principal Performance
Engineer (§0.5): this phase is schema design under a correctness/compliance
bar, not a scaling problem, and the pod treats it that way.
**Scope:** The full §2.1 entity set — `AttendanceRecord`, `LeaveType`,
`LeaveBalance`, `LeaveRequest`, `AbsencePattern` — as one migration in a new
standalone deployable, `attendance-leave-service/` (Node/NestJS), including
`LeaveRequest.is_backdated`/`backdated_reason`/`backdated_approved_by`
(§5.1) and `LeaveBalance.carryover_days_in`/`carryover_expiry_date` plus
`LeaveType.carryover_rules` (§5.2) from this migration, not retrofitted
later. Also stands up the minimal service skeleton needed to run and verify
that migration: `agno_attendance_leave_app`/`attendance_leave` schema+role
(ADR-0073), TypeORM data-source/runtime config, and the platform's standard
`/healthz`/`/readyz`/`/metrics` + tenant-context + domain-error-filter
scaffold. **No badge/biometric ingestion, no `requestLeave` or any other
mutation, no gRPC/REST client or server, no BullMQ, no GraphQL, no NATS.**
Those are Phases 2–8 per §7's own build-phase list. This phase does not call
Module 01/02/04 over any transport — the tenant-context middleware is the
same header-trust placeholder every prior module's Phase 1 started with
(ADR-0014), and every cross-schema id (`scheduled_shift_id`,
`accrual_policy_id`) is a bare, unvalidated `uuid` column.

## Problem

Module 06 is explicitly framed (§0, §0.5) as lower engineering risk than
Modules 03–05 — standard CRUD + approval workflow, not compute-heavy or
high-throughput — and the framing document itself warns against
over-engineering it. Phase 1's job is narrower than Module 05's Phase 1 (no
tempo mismatch to design around, no Redis-vs-Postgres system-of-record
question) but still has two decisions worth pinning now, in schema shape,
rather than leaving for the phase that first needs them:

1. **§2.2 rule 1's "specific double-booking bug class"** — a `LeaveBalance`
   read-then-write race that lets two concurrent `LeaveRequest` submissions
   both succeed against days that only one of them actually has room for —
   is named directly in the module prompt as a correctness bug this module
   must not ship with. The composite PK shape chosen for `LeaveBalance` is
   also the lock granularity Phase 3's enforcement code will depend on, so
   getting that PK right now (rather than a synthetic `id` +
   nullable-unique-constraint shape that would need a later migration to
   fix) avoids a breaking schema change once Phase 3 needs it. See
   ADR-0074.
2. **This module owns two schema/role decisions common to every prior
   service that stood up new Postgres presence** (shared database, new
   schema, new role) — settled, not novel, but still needs its own ADR per
   this platform's convention of one ADR per service's Phase 1 for this
   exact decision (ADR-0017, ADR-0052, ADR-0066 precedent). See ADR-0073.

Beyond those two, this phase follows the precedent every prior module's
Phase 1 set for standing up a new deployable service: reuse the platform's
existing conventions (RLS via `app.current_tenant_id`, `varchar` + `CHECK`
enums per ADR-0003, tenant-id-first indexes, the two-role migrator/app
split, OTel/prom-client/health scaffolding) rather than inventing parallel
ones for a module whose own framing explicitly says not to.

## Decision

A new standalone deployable, `attendance-leave-service/` (Node/NestJS),
sibling to `intraday-service/` rather than a module folded into root
`src/` — consistent with how Modules 03/04/05 were each stood up
independently, and matching this module's own §1 tech-stack table (its own
Postgres schema, its own BullMQ/gRPC/NATS surface in later phases). Runs
outside `docker-compose.yml` against the already-provisioned Postgres
container, same as every other service — no new infrastructure container
needed this phase.

**Schema** (`src/database/migrations/1700000600000-InitialAttendanceLeaveSchema.ts`):
one migration, all five §2.1 tables, in the new `attendance_leave` schema.
Tenant-id-first composite indexes on every table (matching this platform's
universal indexing convention), RLS `ENABLE` + `tenant_isolation` policy on
all five (ADR-0002, unchanged), `varchar` + `CHECK` for every enum-shaped
column (`AttendanceRecord.source`/`exception_type`, `LeaveRequest.status`,
`AbsencePattern.pattern_type`, ADR-0003). `agno_attendance_leave_app` gets
`SELECT, INSERT, UPDATE` on all five tables and nothing more — no `DELETE`
grant anywhere (this module's domain never hard-deletes; cancellation,
rejection, and acknowledgement are all status/column updates), no `CREATE`
on the schema (ADR-0073). Two schema-level `CHECK` constraints worth
calling out specifically:
- `leave_request_backdated_reason_required_check` —
  `NOT is_backdated OR backdated_reason IS NOT NULL` — makes §5.1's
  "mandatory, not optional" backdated-reason requirement structurally
  impossible to violate at the database layer, the same class of guarantee
  ADR-0054 used for `ShiftAssignment.locked` rather than trusting
  application code alone to enforce it on every write path.
- `leave_balance_non_negative_check`/`leave_request_date_range_check`/
  `attendance_record_clock_out_after_clock_in_check` — ordinary domain
  invariants that cost nothing to enforce at the schema layer and catch a
  whole class of application bugs before they corrupt a row.

`LeaveBalance`'s composite PK (`employee_id, leave_type_id, period_start,
period_end`) plus a plain `tenant_id` column (not part of the PK — RLS only
needs the column present, and the PK shape is prescribed verbatim by §2.1)
is deliberately exactly what ADR-0074's Phase 3 row-lock strategy needs —
see that ADR for the concurrency-control reasoning this PK shape exists to
support.

**Entities** (`src/attendance/entities/`, `src/leave/entities/`): TypeORM
classes mirroring the migration's DDL exactly, one per table, each with a
TS `enum` backing its `varchar`+`CHECK` columns for compile-time safety in
application code (ADR-0003's stated split). These exist for query-building
in later phases — nothing in this phase's request path (there isn't one)
touches them yet, same "real but not yet consumed scaffolding" posture
every prior module's Phase 1 entities started in.

**Service skeleton**: `TenantContextService`/`Middleware`/`Module` (own
copy, header-trust placeholder, ADR-0014's convention), `HealthController`
(`/healthz` always-200 liveness, `/readyz` Postgres-fatal readiness — this
module has no Redis-shaped live-state cache to give an asymmetric posture
to, unlike Module 05's ADR-0062), `MetricsService`/`Controller`/`Module`
(prom-client, `/metrics`), `DomainError`/`DomainErrorFilter` (typed error
envelope). `MetricsService` also declares
`attendance_leave_approval_propagation_duration_seconds` now, undocumented
by any real call site until Phase 5 wires §0.5's actual SLO measurement —
declared early so that phase inherits a settled metric name/bucket
convention instead of inventing one under phase pressure.

Observability: `observability/prometheus.yml` gains a fourth Node-service
scrape target (`agno-wfm-attendance-leave-service`, port 8300) — additive,
matching the existing `agno-wfm-intraday-service` entry's shape.

## Blast radius

- Entirely new directory (`attendance-leave-service/`) plus two new docs and
  two new ADRs — zero modification to any Module 01–05 table, migration,
  schema, or running code path.
- Additive edits to two shared files: `scripts/init-roles.sql` gains the
  `agno_attendance_leave_app` role and `attendance_leave` schema block
  (every existing role/schema line untouched); `observability/prometheus.yml`
  gains one new scrape job (every existing job untouched).
- No `docker-compose.yml` change — runs as a local process against the
  already-running Postgres container, same posture as every other service.
- No cross-service call of any kind — nothing in this phase depends on
  Module 01/02/04's running code, and nothing in those services depends on
  this one yet.

## Rollback plan

Delete `attendance-leave-service/`, revert the additive blocks in
`scripts/init-roles.sql` and `observability/prometheus.yml`, drop the
`attendance_leave` schema (`DROP SCHEMA IF EXISTS attendance_leave CASCADE;`
— the migration's own `down()`), remove the two new docs/ADRs. Nothing
external references this schema or service yet, so rollback is a
non-event now — this stops being true once Phase 2+ puts real webhook
traffic and cross-module callers behind it.

Verified against a real local Postgres instance (not just SQL-shape unit
tests): `migration:run` executes cleanly end to end, the app boots against
the resulting schema with the least-privilege runtime role and serves
`/healthz`/`/readyz`/`/metrics` correctly, RLS actually blocks a
cross-tenant read, and the backdated-reason `CHECK` actually rejects a
backdated insert with no reason. One genuine, pre-existing gap surfaced by
this verification, **not specific to this module**: running
`npm run migration:revert` all the way back to a schema's *first*
migration fails with `relation "<schema>.migrations" does not exist`,
because that migration's `down()` (`DROP SCHEMA ... CASCADE`) drops the
same schema TypeORM's own migrations-tracking table lives in, out from
under the CLI's own subsequent bookkeeping `DELETE`. Confirmed identical
behavior in `intraday-service` when reverting its first migration the same
way — this is a property of every service's shared
"`schema: '<service>'`-scoped migrations table + `DROP SCHEMA CASCADE`
first-migration `down()`" convention (ADR-0017/0052/0066/0073), not
something introduced here. The `DROP SCHEMA` itself is transactional and
rolls back cleanly on this error (verified: no partial/corrupted state, the
whole transaction aborts), so this is a CLI-ergonomics gap, not a data-loss
risk — but it means this phase's rollback plan should be read as "drop the
schema directly," not "run `migration:revert` to zero and expect a clean
exit code." Worth a platform-wide fix at some point (e.g. the first
migration in each schema could leave the schema itself in place and only
drop its own tables), but that's a cross-module convention change, not this
phase's to make unilaterally.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Service directory/schema/role name is `attendance-leave-service` /
   `attendance_leave` / `agno_attendance_leave_app`, not `leave-service`.**
   §4's architecture section names the running process "Attendance & Leave
   Service" (not just "Leave Service") and gives it two sub-modules
   (Attendance, Leave) under one bounded context — the module prompt is
   explicit both live in the same service. A shorter single-word name
   (matching `intraday-service`'s style) would read as leave-only and
   undersell that `AttendanceRecord`/exception-detection is real, owned
   scope here too.
2. **Module06→Module04 schedule-conflict checks (§1's "Synchronous gRPC
   against Module 04") will be built as REST, not gRPC, when Phase 3/5
   implement it.** Confirmed with the user rather than decided unilaterally:
   `scheduling-service` (Module 04) currently exposes zero gRPC server —
   it is gRPC-client-only, and the one existing precedent for calling it
   (`intraday-service`'s `ScheduleServiceClient`) already uses REST. Building
   a Python `grpc.aio.Server` into `scheduling-service` with no prior art in
   this repo is real added scope that belongs to a `scheduling-service` ADR
   of its own, not something this module's Phase 1 schema doc should
   silently assume into existence. The *synchronous* requirement (§1: "the
   supervisor needs the operational impact visible before deciding, not
   after") is preserved either way — REST called synchronously satisfies it
   exactly as well as gRPC would; only the transport differs from the
   module prompt's literal wording. The other direction — Module06 exposing
   `LeaveService.GetUnavailability` for Module 04 to pull (§3.4, closing
   scheduling-service's ADR-0059-flagged permanent gap) — **will** be real
   gRPC, using core `src/grpc/grpc.module.ts`'s existing Node-gRPC-server
   pattern, since that direction has real precedent to build on and is the
   half of §3.4 that actually matters (closing Module 04's flagged gap).
   Neither direction is built in this phase.
3. **The approval-chain workflow queue will be real BullMQ (Redis-backed),
   as the module prompt specifies, not this platform's more common
   Postgres-staging-table-+-`@Cron`-drain idiom** (used three times
   already: `core.webhook_deliveries`/`pending_audit_events`/
   `outbox_events`, ADR-0042/0046). Confirmed with the user rather than
   decided unilaterally, since it's new infrastructure with zero prior art
   in this platform. This is a Phase 4 decision to actually wire up; noted
   here only because it means this phase's `.env.example` deliberately does
   *not* yet add a `REDIS_URL`/BullMQ connection block — Phase 4's own
   design doc will carry that, plus the ADR justifying BullMQ against the
   cron-drain precedent.
4. **`LeaveType.carryover_rules` (§5.2's tenant-configurable jsonb rule
   engine) ships in this migration even though no code reads or writes it
   until Phase 7.** The module prompt's "not retrofitted" instruction is
   explicit for `LeaveBalance`'s carryover columns and `LeaveRequest.is_backdated`
   — extending the same reasoning to `LeaveType.carryover_rules` (also
   named in §5.2, also describable as a "carryover field") avoids a second
   ALTER TABLE later for a column with an identical justification.
5. **No `LeaveBalance.tenant_id` in the composite PK**, despite every other
   PK-bearing table in this schema using `tenant_id` as an implicit part of
   its RLS-scoped identity. §2.1 specifies the composite PK verbatim as
   `(employee_id, leave_type_id, period_start, period_end)`; adding
   `tenant_id` to it would change the row-lock semantics ADR-0074 depends
   on for no correctness benefit (an `employee_id` is already
   tenant-unique in this platform's data model — Module 02 owns that
   invariant, this module doesn't re-derive it) and isn't specified.

## Out of scope for this phase (do not build yet)

- Badge/biometric webhook ingestion, `AttendanceRecord` writes from real
  traffic, exception detection against `scheduled_shift_id` — Phase 2.
- `requestLeave`, the gRPC/REST conflict-check calls into Module 04/02,
  `conflict_flags` population, and ADR-0074's concurrency-safe `pending_days`
  enforcement (with its dedicated concurrency test) — Phase 3.
- BullMQ-orchestrated approval chains, `decideLeaveRequest`, balance
  transition on approval — Phase 4.
- `LeaveService.GetUnavailability`/`CheckScheduleConflict` gRPC/REST
  surface, the `agno.leave.request.approved.v1` NATS publish, and the
  explicit re-pointing task back into `scheduling-service`'s own build
  (§3.4) — Phase 5.
- The backdated-leave elevated-permission path and payroll-resync flag
  (§5.1) — Phase 6.
- The carryover/expiry rollover and expiration `@Cron` jobs (§5.2) — Phase 7.
- `AbsencePattern` detection logic, the `acknowledged_by` gate enforced
  end-to-end, GraphQL, dashboards/runbooks — Phase 8.
