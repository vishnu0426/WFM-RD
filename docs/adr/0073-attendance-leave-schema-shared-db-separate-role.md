# ADR-0073: `attendance_leave` is a new schema in the shared `agno_wfm` database, with its own runtime role

## Context
Same answer as ADR-0017/0052/0066, for the same reasons. Module 06 needs its
own durable Postgres presence for `AttendanceRecord`, `LeaveType`,
`LeaveBalance`, `LeaveRequest`, and `AbsencePattern` (§2.1). Nothing about
this module's data volume or access pattern argues for a separate Postgres
instance (unlike Module 05's ClickHouse-shaped mitigation, ADR-0066, this
module is explicitly framed as standard CRUD + approval workflow, §0 - "not
compute-heavy or high-throughput"), and every prior module that stood up a
new deployable service reused the same database with a new schema and a
new least-privilege role rather than provisioning new infrastructure.

## Decision
A new schema, `attendance_leave`, owned by `agno_migrator` (DDL only), and a
new runtime role, `agno_attendance_leave_app`, with `USAGE` on
`attendance_leave` alone - not `core`, `org`, `forecasting`, `scheduling`,
or `intraday`. `agno_attendance_leave_app` gets per-table
`SELECT, INSERT, UPDATE` grants in the initial migration
(`1700000600000-InitialAttendanceLeaveSchema.ts`), no `DELETE` on any table
(cancellation/rejection/acknowledgement are status-column UPDATEs, not row
deletions - nothing in this module's domain needs a hard delete), and no
`CREATE` on the schema itself.

Cross-schema references (`AttendanceRecord.scheduled_shift_id` into Module
04's `ShiftAssignment`, `LeaveType.accrual_policy_id` into Module 02's
`EmploymentPolicy`) are plain `uuid` columns, never a SQL `REFERENCES`
across schemas - same discipline ADR-0052 established: referential
correctness for a cross-module id is a gRPC/REST-contract concern, not
Postgres's, and `agno_attendance_leave_app` structurally cannot read
`org.*`/`scheduling.*` tables even if application code tried to.

## Consequences
- `scripts/init-roles.sql` gains `agno_attendance_leave_app`, the
  `attendance_leave` schema (authorized to `agno_migrator`), and the
  matching `GRANT CONNECT`/`GRANT USAGE`/`ALTER ROLE ... SET search_path`
  lines - additive only, no existing role or schema's grants change.
- Module 06 talks to Module 02's org/policy data and Module 04's schedule
  data exclusively through their own contracts (gRPC/REST, §3.4) - never by
  reading `org.*`/`scheduling.*` tables directly, even for a "just this
  once" read, since the running role has no grant to do so.
- If this module's write volume or access pattern ever turns out not to fit
  standard OLTP Postgres after all (contrary to §0's stated framing), the
  same escape hatch every other module has used remains available: a
  narrowly-scoped `agno_migrator`-credentialed pool for DDL-only jobs
  (`migrator-pool.provider.ts`'s pattern, ADR-0066), not a wholesale
  re-architecture of this decision.
