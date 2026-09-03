# Module 04 Runbook — Scheduling Engine

Operational reference for the Phase 7/8 async worker pool (ADR-0060), the
decomposition path for large solves (ADR-0061), and the two Prometheus
surfaces this module exposes. Every check below is a direct SQL query
against `scheduling.schedule_jobs` (run as any role with `SELECT` on
`scheduling.*` - `agno_migrator` locally) or a scrape of one of the two
`/metrics` endpoints - there is no dashboards backend in this repository.

## 0. The two processes, and which one to look at

- **The API process** (`app.main`, `uvicorn app.main:app`) only enqueues.
  `POST /v1/scheduling/jobs` (and reoptimize, and relaxation-approve) return
  `status: queued` immediately - it never blocks on a solve. Its own
  `/metrics` (default port from `PORT`, 8100 locally) exposes
  `http_request_duration_seconds`/`http_requests_total` (by route template,
  never raw path) and `scheduling_queue_depth` (a `Gauge`, refreshed live on
  every scrape - see `app/core/metrics.py::render_metrics`).
- **The worker process(es)** (`python -m app.worker`, one or more, all
  against the same Postgres) do all the actual work: claim, gRPC pulls,
  decomposition, CP-SAT solve, persistence, the NATS completion publish.
  Horizontal scale is "start more `app.worker` processes" - there is no
  code change or configuration flag for that (ADR-0060 Decision 1/2). Each
  worker's own `/metrics` (`WORKER_METRICS_PORT`, default 8101 - **must be
  distinct per worker instance on the same host**, e.g. 8101/8102/8103 for
  local multi-worker dev) exposes `scheduling_jobs_total` (by terminal
  status), `scheduling_solve_duration_seconds` (by `scope_size` bucket:
  small <50 employees, medium <=200, large >200 - see
  `app/core/worker_metrics.py::scope_size_bucket`), and
  `scheduling_relaxation_category_total`.

If a job never leaves `queued`: look at the workers (are any running? are
they all draining?), not the API process - the API process has no code path
that ever touches a job after the initial `INSERT`.

## 1. Is the queue backed up?

```sql
SELECT status, count(*), min(requested_at) AS oldest
FROM scheduling.schedule_jobs
WHERE status IN ('queued', 'solving')
GROUP BY status;
```
Same numbers as `scheduling_queue_depth{status="queued"|"solving"}` on the
API process's `/metrics` - use the SQL when you need `oldest` too (the
metric alone can't tell you how long the head-of-line job has been waiting).

- A growing `queued` count with workers known to be running and not draining
  means solve demand is outrunning capacity - see §3 (scale up) before
  anything else.
- `oldest` more than a few multiples of `worker_poll_interval_seconds`
  (default 1.0s) past `now()` with workers confirmed running is unusual -
  check worker logs for a crash loop (§2).
- `solving` count roughly equal to the number of live worker processes, with
  none of them older than your real p99 solve time, is normal - some jobs
  are always mid-solve when workers are healthy and busy.

## 2. A job is stuck, or a worker died mid-solve

**The reaper handles this automatically** - every worker sweeps
`schedule_jobs` for rows stuck in `solving` past
`WORKER_REAPER_STUCK_THRESHOLD_SECONDS` (default 300s) *before* attempting
its next claim (`app/worker.py::Worker._reap_once`, every poll cycle, so
recovery latency is bounded by the poll interval, not the full reaper
period). A stuck job's `attempt_count` is incremented and it's requeued; a
job that has already reached `WORKER_REAPER_MAX_ATTEMPTS` (default 3) is
instead marked `failed` with `relaxationsApplied.failureReason.code =
"REAPER_MAX_ATTEMPTS_EXCEEDED"` - a "poison" job the reaper stops retrying
forever (`app/services/queue_service.py::reap_stuck_jobs`).

**Manual diagnosis, if the automatic recovery itself looks wrong:**
```sql
SELECT id, tenant_id, status, claimed_by, solving_started_at, attempt_count,
       now() - solving_started_at AS stuck_for
FROM scheduling.schedule_jobs
WHERE status = 'solving'
ORDER BY solving_started_at ASC;
```
- `claimed_by` is `"<hostname>:<pid>"` (`app/worker.py`'s own `worker_id`) -
  cross-reference against which worker process (still alive? already
  restarted under a new pid?) actually owns it.
- If `stuck_for` is comfortably under the threshold, it's simply still
  solving - a genuinely large/hard input can legitimately take a while (see
  §4 for how to tell whether it decomposed). Don't intervene.
- If `stuck_for` is well past the threshold and *not* being reaped, no
  worker process is currently alive to run the sweep - start one; the very
  next poll cycle recovers every stuck row across the whole table, not just
  the one that paged.

**Manual override (only if you understand why the reaper itself isn't the
right tool here - e.g. an emergency during an incident):**
```sql
-- Force-requeue one specific job right now, bypassing the threshold wait
UPDATE scheduling.schedule_jobs
SET status = 'queued', claimed_by = NULL, solving_started_at = NULL
WHERE id = '<job_id>' AND status = 'solving';

-- Force-fail one specific job right now (it will not be retried again)
UPDATE scheduling.schedule_jobs
SET status = 'failed', completed_at = now(),
    relaxations_applied = COALESCE(relaxations_applied, '{}'::jsonb) ||
      '{"failureReason": {"code": "MANUAL_INTERVENTION", "message": "operator forced failed via runbook", "details": {}}}'::jsonb
WHERE id = '<job_id>' AND status = 'solving';
```
Either statement bypasses RLS as `agno_migrator` (or any role not subject to
the tenant policy) - there is no API endpoint for this today, deliberately;
it's a break-glass action, not a supported client operation. A
force-failed job does **not** get its NATS completion event published
automatically - publish `agno.scheduling.job.completed.v1` by hand if a
downstream consumer (Module 10) is depending on it, or accept that consumer
sees nothing for this job.

## 3. Scaling workers / graceful shutdown

**Scale up:** start another `python -m app.worker` process (own
`WORKER_METRICS_PORT` if co-located on one host) against the same
`DB_*`/`NATS_URL`. No coordination needed - `SELECT ... FOR UPDATE SKIP
LOCKED` (`app/services/queue_service.py::claim_next_job`) is what makes
concurrent workers safe; there is no leader election or partitioning of
which worker handles which tenant/job.

**Scale down / deploy:** send `SIGTERM` (or `SIGINT`). The worker stops
claiming *new* jobs immediately but always finishes whatever claim is
already in flight, however long that takes (`app/worker.py::Worker.run`'s
own drain check happens only between claims, never mid-solve) - there is no
forced cutoff inside the process itself. `WORKER_SHUTDOWN_GRACE_SECONDS`
(default 300s) is **not** enforced by this process - it's the number your
orchestration platform's own termination lifecycle should use
(`terminationGracePeriodSeconds` in Kubernetes, or equivalent), so the
platform doesn't `SIGKILL` a worker that's still legitimately finishing a
long solve. Set it comfortably above your real p99 solve time (see the load
test results doc for one measured data point, not a general SLA).

**Confirm a worker actually drained cleanly** (rather than being killed
mid-solve): its own log stream ends with `"worker drained, shutting down"`
after a `"worker received shutdown signal - draining"` line, with no
`"job execution raised an unhandled exception"` in between. A worker killed
mid-solve (`SIGKILL`, or a grace period that ran out) leaves its
in-flight job's row in `solving` with a stale `claimed_by` - the reaper on
any *other* running worker recovers it per §2 as soon as the threshold
elapses; nothing about this is silent data loss, but it does mean a hard
kill costs you up to `worker_reaper_stuck_threshold_seconds` of extra
latency on that one job.

## 4. A large job - did it actually decompose, and did decomposition help or hurt?

```sql
SELECT id, status, solve_duration_ms, decomposition_plan
FROM scheduling.schedule_jobs
WHERE id = '<job_id>';
```
`decomposition_plan` is `null` for anything at or below
`DECOMPOSITION_EMPLOYEE_THRESHOLD` (200 employees - `app/solver/
decomposition.py`) - decomposition is a deliberate no-op below that, not a
missing field. Above it, `decomposition_plan.decomposed` is `true` only if
the shifts actually spanned >= 2 distinct `orgUnitId` values *and* every
shift had one set at all (a shift missing `orgUnitId` disables decomposition
for the whole job, on purpose - see ADR-0061 Decision "safer to not
decompose than to guess"). `decomposition_plan.groups[]` gives you
`employeeCount`/`shiftCount`/`status`/`solveDurationMs` per group - useful
for telling "one pathological site is dragging the whole job out" (one
group's `status: "unknown"` or a `solveDurationMs` far above the others)
apart from "this job is just genuinely large everywhere."

`solve_duration_ms` on the job row itself is the **sum** across every
group's own CP-SAT time (`_sum_or_none` in `job_service.py`) - it is *not*
the job's total wall time. At real scale, orchestration overhead
(decomposition's own `O(sites x employees)` group-materialization pass, plus
gRPC pulls, plus persistence) can be a meaningful fraction of total wall
time even when every individual CP-SAT solve is fast - see
`docs/module-04-phase-7-load-test-results.md` for one real, measured run
(100k employees, 500 sites: ~7.9s of summed CP-SAT time inside a ~17s total
wall time). If wall time is the actual complaint and `solve_duration_ms`
looks small, the gap is orchestration overhead, not the solver - re-run
`scripts/load_test_decomposition.py` at a comparable scale to confirm before
assuming a regression.

**A `status: "unknown"` group above `COMMERCIAL_FALLBACK_EMPLOYEE_THRESHOLD`
(300 employees)** means CP-SAT hit its time budget without proving
feasibility or infeasibility, and there is no commercial solver (Gurobi/
CPLEX) configured to fall back to in this environment
(`app/solver/commercial_fallback.py` - ADR-0061). The job resolves `failed`
with `failureReason.code` reflecting that. This is not a bug to "fix" by
retrying - it needs either a real commercial solver license wired in, or the
input broken into genuinely smaller/more constrained sub-problems by
whoever owns that org unit's data.

## 5. Infeasible-rate-by-org-unit and other per-tenant slicing

**Not a Prometheus label, on purpose** (`org_unit_id` is unbounded
cardinality - see `app/core/worker_metrics.py`'s own module docstring for
the full reasoning, same discipline as `forecasting-service`'s "route label,
never raw path"). Every terminal job outcome is logged instead
(`job_service._publish`), structured JSON with `jobId`/`tenantId`/
`orgUnitId`/`jobKind`/`status`/`solveDurationMs` as fields - slice
"infeasible rate by org unit" from whatever log-aggregation backend ingests
this process's stdout (Loki/Elasticsearch/CloudWatch Logs Insights), not
from Prometheus. There is no such backend wired up in this local
environment - `grep`/`jq` over captured stdout is the local-dev equivalent.

## Standing gaps this runbook does not paper over

No true cross-worker parallelism for a single decomposed job's groups
(sequential within one worker's claim - ADR-0061 Decision 3, a deliberate
scope boundary, not an oversight). No commercial-solver fallback wired to a
real license (§4 above). No automated partition rotation for
`shift_assignments`/`fairness_ledger` beyond the "current month +/- 1"
bootstrap migration 0001 creates - scheduling a job far enough in the future
fails closed with a Postgres `CheckViolationError` ("no partition of
relation ... found for row") rather than a clean domain error; this is
ADR-0053's own explicitly deferred scope (pg_partman or equivalent is
infra/process work, not this module's), but it is a real, reachable
production gap worth a monitor on "oldest partition upper bound vs. now()"
if this module is ever asked to schedule more than ~1 month out. No
authentication/RBAC (pre-existing platform-wide gap, not Phase 7/8's to
fix). See the Phase 7/8 production readiness checklist for the complete,
categorized list.
