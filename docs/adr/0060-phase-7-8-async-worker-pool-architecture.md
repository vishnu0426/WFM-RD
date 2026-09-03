# ADR-0060: Phase 7/8 async worker pool — DB-claim queue, platform-admin RLS bypass scoped to one table, graceful draining, reaper

## Context
Every phase since Phase 2 has flagged the same gap: `POST /v1/scheduling/jobs`
solves synchronously inside the HTTP request (ADR-0055's own accepted
trade-off, restated as an open item in every subsequent phase's readiness
checklist). §7.2 is written assuming this gap is already closed — "graceful
draining" (a worker finishes its in-flight solve before terminating, stops
accepting new jobs) and the reaper ("a solve is genuinely killed... the job
must be requeued from `solving` back to `queued`") both presuppose a
worker that is a distinct, killable unit of execution separate from the
HTTP request that submitted the job. That distinction doesn't exist yet.
This phase builds it for real, not as a documentation exercise.

## Decision 1: a separate worker process, not a thread pool inside the FastAPI app
`app/worker.py` is a standalone entrypoint (`python -m app.worker`), not
part of `uvicorn app.main:app`. CP-SAT solves are CPU-bound and block the
Python interpreter running them; keeping them out of the ASGI event loop
entirely (a genuinely separate OS process) is simpler and more honestly
"graceful-drainable" than an in-process thread/task pool competing with
HTTP request handling for the same interpreter. Multiple worker processes
can run concurrently against the same Postgres — horizontal scale is
"start more processes," not a code change.

## Decision 2: `SELECT ... FOR UPDATE SKIP LOCKED` against `schedule_jobs` itself — no second queue system
Considered a NATS JetStream work-queue consumer (this module already has
`js`/JetStream wired up for the completion event) instead. Rejected:
`ScheduleJob` rows are already this module's own durable, transactional
source of truth — a second, parallel queue (NATS) would mean a dual-write
problem (the row must exist *and* a queue message must exist, and the two
can drift: a row created without a message is silently stuck, a message
without a row is a crash waiting to happen) for no benefit a NATS-based
design would give here. `SELECT ... FOR UPDATE SKIP LOCKED` is a
well-established, transactionally-consistent claim pattern: multiple
workers polling the same query never claim the same row (the lock+skip
semantics make concurrent claims mutually exclusive without workers
blocking each other), and "claimed" is simply "this row's own `status`
column changed," so there is exactly one place a job's state ever lives.

```sql
UPDATE scheduling.schedule_jobs
SET status = 'solving', claimed_by = :worker_id, solving_started_at = now(), updated_at = now()
WHERE id = (
  SELECT id FROM scheduling.schedule_jobs
  WHERE status = 'queued'
  ORDER BY requested_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

## Decision 3: `app.is_platform_admin` RLS bypass, scoped to `schedule_jobs` only — every other query stays tenant-scoped
The claim query above must see queued jobs *across every tenant* — the
worker is a platform-level process, not acting on behalf of one tenant.
Every other table this module owns keeps its existing, unmodified
`tenant_id = current_setting('app.current_tenant_id')`-only RLS policy
(ADR-0002's convention, unchanged). Widening `schedule_jobs`'s own policy to
also allow `current_setting('app.is_platform_admin', true) = 'true'`
mirrors Module 01/02's own already-established pattern for exactly this
class of problem (`core.tenants`' own RLS policy has the identical shape,
verified directly against their real running code in Phase 6) — not a new
convention invented here. The moment the worker has *claimed* a job (and
therefore knows its `tenant_id`), every subsequent query for that job
(building `SolveInput`, persisting `Schedule`/`ShiftAssignment`, fairness
lookups) goes through the exact same `tenant_scoped_session` every HTTP
request already uses — a new `platform_admin_session()` context manager
(`app/db/session.py`) is used *only* for the claim query itself, nothing
else. `agno_migrator` (which would bypass RLS entirely, being the table
owner) is deliberately never used here — that would collapse the two-role
split (§2.2 rule 2 / ADR-0002) every phase of this platform has held to:
the worker is application code, and application code runs as
`agno_scheduling_app`, full stop.

## Decision 4: one `ScheduleJob` row, one `job_kind`, dispatched by the worker
`create_job`, `approve_relaxation`, and `reoptimize_schedule` all
ultimately mean "run `solve()` and persist the result" — they differ only
in *what* gets solved and *how the inputs are sourced*. Rather than three
separate execution paths, `ScheduleJob` gains a `job_kind` column
(`submit` | `relaxation_approval` | `reoptimize`, default `submit` for
every pre-Phase-7 row) and the worker dispatches on it:

- **`submit`**: `request_payload` (new jsonb column) holds the original
  `ScheduleJobRequest` body (`model_dump(mode="json", by_alias=True)`) -
  the worker re-derives `SolveInput` from it exactly the way
  `_build_solve_input` already does (gRPC pulls included - §4.3's own
  "the worker pulls exactly what it needs at solve time" language,
  finally true in the literal sense: pulls now happen worker-side, not in
  the HTTP handler).
- **`relaxation_approval`**: no new payload needed - the worker re-reads
  the *same* row's own `solve_input_snapshot` + `relaxations_applied.
  attemptedCategories` (Phase 4's existing fields), exactly what
  `approve_relaxation` already did synchronously. Approving a relaxation
  no longer re-solves inline in the approval request; it flips `status`
  back to `queued` with `job_kind=relaxation_approval` and a worker picks
  it up.
- **`reoptimize`**: `request_payload` holds the resupplied roster/policy/
  shiftSlots/leaveRecords/constraintConfig; `target_schedule_id` (new
  column) names the schedule being reoptimized, for the locked-assignment
  matching logic (ADR-0058) the worker performs exactly as
  `reoptimize_schedule` already did synchronously.

## Decision 5: API endpoints enqueue and return `queued` — every synchronous solve call is gone
`POST /v1/scheduling/jobs`, `POST /v1/scheduling/jobs/{jobId}/relaxation/approve`,
and `POST /v1/scheduling/schedules/{scheduleId}/reoptimize` now do exactly
one thing: validate the request shape, persist a `queued` `ScheduleJob` row
(or, for relaxation approval, flip an existing row back to `queued`), and
return `202`-shaped-as-`{jobId, status: "queued"}` immediately. **No gRPC
pull, no CP-SAT call, ever runs on the request thread from this phase
onward.** A caller polls `GET /v1/scheduling/jobs/{jobId}` (unchanged
shape) until `status` reaches a terminal value - the same poll loop §4.1
always described, just now genuinely meaningful (`queued`/`solving` are
real, observable, non-instantaneous states) instead of a formality a
synchronous response made moot.

**This is a breaking response-shape change for anything that assumed
`POST /jobs` returns a terminal status.** Every existing test that asserted
`status: "completed"` immediately after `POST` needed updating to poll
`GET` until terminal instead - a real, acknowledged migration cost, paid
once, in this phase.

## Decision 6: graceful draining via `SIGTERM` + an in-flight-completion flag
`app/worker.py` installs a `SIGTERM` handler that sets a `draining` flag,
checked *before* each new claim attempt (never mid-solve — a solve in
progress always finishes). No new claims are attempted once draining;
the process exits once its current claim (if any) completes. A
configurable grace period (`WORKER_SHUTDOWN_GRACE_SECONDS`, matching §0.5's
own instruction to size this off the real p99 solve time, not a generic
default) bounds how long an orchestrator (Kubernetes `preStop` + a matching
`terminationGracePeriodSeconds`) waits before a harder kill.

## Decision 7: the reaper is a periodic sweep inside every worker, not a separate process
Every worker, on each poll cycle (before attempting a claim), also runs:

```sql
UPDATE scheduling.schedule_jobs
SET status = 'queued', claimed_by = NULL, solving_started_at = NULL,
    attempt_count = attempt_count + 1, updated_at = now()
WHERE status = 'solving'
  AND solving_started_at < now() - interval '{REAPER_STUCK_THRESHOLD_SECONDS} seconds'
  AND attempt_count < {MAX_ATTEMPTS};
-- attempt_count >= MAX_ATTEMPTS: marked `failed` instead of requeued (see below)
```

Also run under the platform-admin RLS bypass (it must see every tenant's
stuck jobs). Safe under multiple concurrent workers: a plain `UPDATE...WHERE`
needs no explicit locking beyond what Postgres's own MVCC already
guarantees (two workers racing this sweep either both no-op on an
already-fixed row, or one succeeds and the other's `WHERE` no longer
matches) - no separate leader-election or single-reaper-instance
requirement. `attempt_count` caps requeue churn: a job that fails to solve
cleanly `MAX_ATTEMPTS` times running (a "poison" job - e.g. a genuinely
un-decomposable oversized input that reliably times out) is marked `failed`
with a reason rather than requeued forever.

## Consequences
- `alembic upgrade head` (migration `0004`) adds `job_kind`,
  `request_payload`, `target_schedule_id`, `claimed_by`,
  `solving_started_at`, `attempt_count` to `schedule_jobs`, and widens that
  table's own RLS policy - every other table's policy is untouched.
- Every pre-Phase-7 `ScheduleJob` row defaults to `job_kind='submit'`,
  `attempt_count=0` - existing data reads unchanged.
- `job_service.py` splits into enqueue functions (fast, API-side, no
  solving) and an `execute_job` function (the actual gRPC-pull/decompose/
  solve/persist/publish work, worker-side) - see the Phase 7 design doc's
  blast-radius section for the full file-level breakdown.
- Local dev/testing now requires running `python -m app.worker` alongside
  `uvicorn` for a submitted job to ever leave `queued` - documented in the
  README's "Getting started," and integration tests either run a worker
  fixture inline or poll with a bounded timeout and treat "still queued
  after N seconds" as a real, actionable test failure, not a flake to
  retry away.
