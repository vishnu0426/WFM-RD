# Module 04 Phase 8 Design Doc — Scheduling Engine: Async Worker Pool, Zero-Downtime Deploy, Observability

**Status:** Approved for implementation
**Owner:** Scheduling pod (Module 04) — Platform/Infra-leaning engineer
**Scope:** §7.2's zero-downtime deploy support (graceful draining, a reaper
for stuck-in-solving jobs) and observability/hardening (structured logging,
Prometheus metrics on both processes). Pulled forward and built alongside
Phase 7 rather than after it — see `docs/module-04-phase-7-design-doc.md`'s
"A scope fork resolved by asking, not guessing" for why draining/reaping
needed a genuine async worker pool to be meaningful mechanics rather than
near-no-ops against an always-empty queue.

## Problem

Every prior phase's checklist carried the same honestly-stated gap: CP-SAT
solves synchronously, inline in the HTTP request thread. That's fine for
Phase 2's synthetic test scenarios (milliseconds) but is a real production
blocker on two fronts §7.2 names directly: **zero-downtime deploys** (a
process can't gracefully finish in-flight work and stop accepting new work
if "in-flight work" means "a live HTTP connection blocked inside a CP-SAT
call for however long that takes") and **horizontal scale under load**
(one FastAPI worker process solving synchronously means concurrent job
submissions queue up behind the ASGI event loop itself, not behind anything
designed to absorb that queuing).

## Decision

**A separate OS process (`app.worker`), not a thread pool inside the FastAPI
process.** CP-SAT is CPU-bound; running it inside the ASGI event loop (even
via `run_in_executor`) still ties solve capacity to the same process
handling HTTP traffic, and still complicates graceful shutdown (the ASGI
server's own drain logic now has to know about in-flight solves it didn't
initiate). A fully separate process gives the API and the solving capacity
independent lifecycles, independent scaling (`replicas` for the API tier are
about HTTP throughput; `replicas` for the worker tier are about solve
throughput — conflating them wastes capacity in whichever direction demand
is lopsided), and a clean, already-well-understood deployment shape
(a stateless HTTP Deployment + a separate worker Deployment, both talking to
the same Postgres).

**`POST /v1/scheduling/jobs` (and reoptimize, and relaxation-approve) now
only enqueue — a real, acknowledged breaking response-shape change.** Every
one of these endpoints returns `status: queued` immediately; a caller polls
`GET /{jobId}` for the real outcome. This is not a subtle behavior change —
every prior phase's own integration tests asserted a terminal status
directly off the `POST` response, and every one of them needed rewriting
(`poll_until_terminal`, `tests/integration/conftest.py`) to keep testing
what they actually meant to test. Paid once, deliberately, rather than
building a `?sync=true` compatibility shim: a shim would mean the
synchronous-blocking-request problem this phase exists to solve still has a
live code path, undermining the whole point.

**`SELECT ... FOR UPDATE SKIP LOCKED` against `schedule_jobs` itself, not a
second NATS work queue.** A NATS-based queue was considered and rejected:
it would mean two independent sources of truth for "is this job claimed"
(a NATS message's ack state and the row's own `status` column) that could
drift out of sync under a crash between the two — a worker that claims a
NATS message, crashes before updating the row, and never redelivers (or
redelivers into a second worker that finds the row already `solving` and
has no clean way to tell "genuinely in progress elsewhere" from "orphaned")
is exactly the kind of dual-write bug this module's own §0 rigor exists to
avoid inventing. `FOR UPDATE SKIP LOCKED` makes Postgres itself the single
source of truth: a worker's claim and the row's new `solving` status are
the same atomic statement (`app/services/queue_service.py::
claim_next_job`), so there is no window where two independent systems can
disagree about who owns a job.

**A narrowly-scoped platform-admin RLS bypass, on exactly one table.** The
claim query and the reaper sweep both need to see queued/stuck jobs across
*every* tenant — the whole point of a shared worker pool is that one
worker instance serves all tenants, not one per tenant. Migration 0004
widens `schedule_jobs`' own RLS policy with an `OR current_setting
('app.is_platform_admin', true) = 'true'` clause, mirroring a pattern
Module 01/02 already established for `core.tenants` — not a new pattern
invented for this phase. `platform_admin_context()`
(`app/core/tenant_context.py`) is used for exactly two call sites in the
entire codebase (the claim query, the reaper sweep) plus the `/metrics`
queue-depth gauge — every other query in this service remains ordinarily
tenant-scoped. Once a job is claimed, execution itself opens a normal
tenant-scoped session for that job's own `tenant_id` (`app/worker.py::
Worker._execute_claim`) — the bypass exists only for the cross-tenant
discovery step, never for the actual work.

**`job_kind` unifies three previously-separate synchronous code paths into
one worker dispatch point.** Before this phase, `create_job`,
`approve_relaxation`, and `reoptimize_schedule` were three independent
functions that each built a `SolveInput` and called `solve()` inline.
`job_kind` (`submit`/`relaxation_approval`/`reoptimize`) plus
`request_payload`/`target_schedule_id` (migration 0004) let
`job_service.execute_job` dispatch to the right one from a single worker
loop — `relaxation_approval` needs no new payload at all (it reuses the same
row's own `solve_input_snapshot`/`relaxations_applied` from whenever the
job first went infeasible), which is why the claim query specifically
excludes only `submit` jobs with a `NULL` `request_payload` (Phase 1's
"queued forever, nothing to solve" behavior for an empty-`shiftSlots`
submission), not every job kind uniformly.

**Graceful draining: a flag checked only between claims, never mid-solve.**
`Worker.request_drain()` (called from `SIGTERM`/`SIGINT` handlers,
`asyncio.get_running_loop().add_signal_handler`) sets an `asyncio.Event`;
`Worker.run()`'s loop checks it before each new claim attempt, never
interrupts a claim already in progress. This means a worker's own shutdown
latency is bounded by its current solve's own duration, not by a fixed
timeout the process enforces on itself — `WORKER_SHUTDOWN_GRACE_SECONDS`
is deliberately *not* enforced by this process; it documents the number the
orchestration platform's own termination lifecycle
(`terminationGracePeriodSeconds` or equivalent) should use, so the platform
doesn't `SIGKILL` a worker that's still legitimately finishing real work.

**The reaper is a sweep inside every worker, not a separate process.**
`Worker._reap_once` runs every poll cycle, before each claim attempt — a
job stuck in `solving` (a worker that died mid-solve without a clean
`SIGTERM`, not a graceful shutdown, which never leaves a row in `solving`
past its own completion) past `WORKER_REAPER_STUCK_THRESHOLD_SECONDS` gets
requeued with `attempt_count` incremented; a job that's already exhausted
`WORKER_REAPER_MAX_ATTEMPTS` is marked `failed` instead of requeued forever
(a "poison" job — e.g. a genuinely oversized, un-decomposable input that
reliably times out). Safe under multiple concurrent workers via a plain
`UPDATE ... WHERE` — no explicit locking needed beyond what the `WHERE`
clause's own conditions already guarantee (Postgres's MVCC means two
workers' concurrent sweeps simply both succeed against the rows each
individually matches; there's no meaningful race to coordinate since
requeuing/failing a job is idempotent from either worker's perspective).

**Two separate Prometheus registries, because there are two separate OS
processes.** `app/core/metrics.py` (`REGISTRY`, the FastAPI process's own
HTTP-level `http_request_duration_seconds`/`http_requests_total` plus the
live-queried `scheduling_queue_depth` gauge) and `app/core/worker_metrics.py`
(`WORKER_REGISTRY`, each worker's own `scheduling_jobs_total`/
`scheduling_solve_duration_seconds`/`scheduling_relaxation_category_total`)
cannot be merged — a worker process has no other HTTP surface, so it needs
its own `prometheus_client.start_http_server` on a distinct port
(`WORKER_METRICS_PORT`), and the API process could never see a worker's
in-memory counters even if it wanted to (they're different processes with
different address spaces). Queue depth specifically is a live pull-time
query on every `/metrics` scrape of the *API* process (`render_metrics`),
not a push from a worker, for the same reason.

**"Infeasible rate by org unit" is a structured log field, deliberately not
a Prometheus label.** `org_unit_id` is unbounded cardinality — the same
"route label, never raw path" discipline `forecasting-service`'s own
`app/core/metrics.py` already states for this platform (ADR-0026 Decision
7), applied here to the worker's own terminal-outcome logging
(`job_service._publish`, which logs `jobId`/`tenantId`/`orgUnitId`/
`jobKind`/`status`/`solveDurationMs` as structured JSON fields on every
terminal outcome). A real deployment slices this from a log-aggregation
backend (Loki/Elasticsearch), not from Prometheus — documented explicitly
in `app/core/worker_metrics.py`'s own module docstring and the runbook,
not a silent omission.

## Verified against real infrastructure, not mocked

`tests/integration/conftest.py::_run_worker` (session-scoped, autouse)
launches a genuine `python -m app.worker` subprocess for the whole
integration test session — the same topology a real deployment uses (a
separate OS process, not something the test's own event loop drives
directly), so the actual `SELECT ... FOR UPDATE SKIP LOCKED` claim
mechanics and the platform-admin RLS bypass are exercised for real, not
assumed correct because `job_service.execute_job` was called in-process.
`poll_until_terminal` is how every affected test now waits for a job's real
outcome. `tests/integration/test_worker_and_reaper.py` goes further,
proving the queue mechanics directly rather than only indirectly through a
job's eventual outcome: concurrent claims against two queued jobs never
double-claim the same row (`asyncio.gather` racing two `claim_next_job`
calls), a stuck-in-`solving` row gets requeued with `attempt_count`
incremented, a row already at `maxAttempts` gets marked `failed` instead of
requeued forever, and `Worker.request_drain()` genuinely causes `Worker
.run()` to return rather than merely setting a flag nothing reads.

## Blast radius

- New: `app/worker.py`, `app/services/queue_service.py`, `app/core/
  logging_config.py`, `app/core/metrics.py`, `app/core/worker_metrics.py`,
  migration `0004_phase7_8_async_worker_pool.py`.
- `app/services/job_service.py` fully restructured: `enqueue_submit_job`/
  `enqueue_relaxation_approval`/`enqueue_reoptimize` (API-side, fast, no
  solving) split from `execute_job`/`_execute_submit`/
  `_execute_relaxation_approval`/`_execute_reoptimize`/
  `_decompose_solve_persist` (worker-side).
- `app/api/v1/jobs.py`/`app/api/v1/schedules.py` shrink substantially —
  all gRPC-pull/solve-input-building code moved to the new
  `app/services/solve_input_resolver.py` (worker-side now).
- A real, acknowledged breaking API change (§ above): every job-producing
  endpoint's `status` in its immediate response is now always `queued`.
- A real, acknowledged semantic change: validation errors that used to be
  synchronous 4xx/503/409 HTTP responses during solving
  (`InvalidShiftDefinitionError`, `LockedAssignmentEmployeeMissingError`,
  `UpstreamDataUnavailableError`, `ShiftHeadcountUndeterminedError`,
  `LockedShiftMissingFromReoptimizeRequestError`) now surface as an async
  `failed` job with a structured `relaxationsApplied.failureReason`
  instead, since there's no HTTP response left to attach them to once
  solving moves off the request thread. Enqueue-time checks that don't
  require solving (schedule exists/not archived for reoptimize; job-not-
  infeasible/no-feasible-relaxation/already-approved for relaxation
  approval) remain synchronous — ADR-0060's own "fast checks stay
  synchronous, anything requiring the solver moves to the worker" line.

## Explicit assumptions (spec was ambiguous or silent here)

1. **One worker process claims and fully executes one job at a time —
   concurrency comes from running more worker processes, not from one
   process handling multiple claims concurrently.** Simpler to reason
   about and to reap correctly; a worker that's mid-solve genuinely can't
   do anything else useful anyway (CP-SAT is synchronous, CPU-bound code
   within that claim).
2. **The reaper's `attempt_count` is a per-job counter, not per-worker.**
   A job requeued by the reaper can be picked up by any worker, including
   the one that originally had it — there's no "don't retry with the same
   worker" logic, since a transient issue (a brief DB blip, a restart) isn't
   necessarily tied to which specific process handles the retry.
3. **`WORKER_SHUTDOWN_GRACE_SECONDS` is documentation, not enforcement.**
   Explicit choice (see Decision above) — enforcing it inside the process
   itself would mean either interrupting a solve mid-flight (defeating the
   point of "always finish in-flight work") or the setting being
   meaningless (since the process would just keep running past it anyway
   for however long the solve takes).
4. **A force-failed job (manual intervention, see the runbook) does not
   auto-publish its NATS completion event.** The reaper's own poison-job
   path does publish (`app/worker.py::Worker._reap_once`); a human bypassing
   the normal machinery via direct SQL is assumed to also know whether a
   downstream consumer needs to be told, and to do so deliberately rather
   than have it happen as a side effect of an `UPDATE` statement.

## Out of scope for this phase (do not build yet)

- Any actual Kubernetes/deployment manifests, `HorizontalPodAutoscaler`
  configuration, or CI/CD pipeline wiring — this phase builds the
  application-level mechanics zero-downtime deploy and horizontal scaling
  *depend on*; the platform-level manifests that actually invoke them are
  a different team's/phase's concern, same as every prior phase's stated
  Terraform/Vault non-goals.
- A dead-letter queue or alerting integration for poison jobs — the reaper
  marks them `failed` with a structured reason and logs a warning; nothing
  pages anyone automatically. The runbook documents what to watch for
  manually/via a log-based alert a real deployment would need to wire up.
- `pg_partman` or any automated partition-rotation tooling — a real,
  separately-flagged gap (ADR-0053, this phase's own load test hit it
  directly) that predates this phase and remains explicitly out of scope
  for it.
