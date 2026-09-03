# Module 04 Phase 8 Production Readiness Checklist

Same honesty bar as every prior phase's checklist.

## Delivered in this phase (application code)

- [x] A real, separate `app/worker.py` process — `SELECT ... FOR UPDATE
      SKIP LOCKED` claim (`app/services/queue_service.py`), `job_kind`
      dispatch (`submit`/`relaxation_approval`/`reoptimize`) unifying three
      previously-separate synchronous code paths into one execution point,
      graceful `SIGTERM`/`SIGINT` draining that always finishes an in-flight
      claim before stopping, and a reaper sweep (every poll cycle, before
      each claim attempt) that requeues jobs stuck in `solving` and marks
      poison jobs (past `maxAttempts`) `failed` instead of retrying forever.
- [x] `POST /v1/scheduling/jobs`/reoptimize/relaxation-approve now enqueue
      only, returning `status: queued` immediately — a real, acknowledged
      breaking response-shape change, not a silently-added `?async=true`
      opt-in. Every pre-existing integration test updated to poll for the
      real outcome (`poll_until_terminal`), not weakened to stop checking.
- [x] Migration `0004_phase7_8_async_worker_pool.py`: `job_kind`,
      `request_payload`, `target_schedule_id`, `claimed_by`,
      `solving_started_at`, `attempt_count` added to `schedule_jobs`;
      `schedule_jobs`' own RLS policy widened with a platform-admin bypass
      clause, scoped to exactly this one table, mirroring Module 01/02's
      own `core.tenants` policy pattern — verified directly against real
      Postgres (platform-admin session sees rows across every tenant; an
      unrelated tenant sees zero), not merely asserted correct from the
      migration's own SQL.
- [x] Two independent Prometheus surfaces, correctly split across the two
      processes that actually need them: `app/core/metrics.py` (HTTP-level,
      the FastAPI process, plus a live-queried `scheduling_queue_depth`
      gauge) and `app/core/worker_metrics.py` (solve-duration-by-
      scope-size, jobs-by-terminal-status, relaxation-category frequency —
      each worker's own registry/port, since a worker has no other HTTP
      surface). "Infeasible rate by org unit" deliberately implemented as
      structured JSON logging, not an unbounded-cardinality Prometheus
      label — documented as a deliberate trade-off, not an oversight.
- [x] `app/core/logging_config.py`: structured JSON logging shared by both
      processes.
- [x] Verified against real infrastructure throughout: a genuine
      `python -m app.worker` subprocess (not `job_service.execute_job`
      called in-process) drives the whole integration test session
      (`conftest.py::_run_worker`), and `test_worker_and_reaper.py` proves
      the queue mechanics directly — concurrent claims never double-claim
      (`FOR UPDATE SKIP LOCKED` proven, not assumed from reading the SQL),
      the reaper genuinely requeues/poison-fails, and `request_drain()`
      genuinely causes the run loop to return.
- [x] An on-call runbook (`docs/module-04-runbook.md`) covering queue-depth
      diagnosis, stuck-job recovery (automatic and manual break-glass),
      worker scaling/graceful-shutdown confirmation, decomposition-outcome
      diagnosis, and where to find infeasible-rate-by-org-unit data.
- [x] `ruff`/`mypy --strict` clean; 132 tests (unit + integration) passing
      against real Postgres/NATS.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Any actual Kubernetes manifests, `HorizontalPodAutoscaler`, or
      CI/CD pipeline wiring.** This phase builds the application-level
      mechanics zero-downtime deploy and horizontal scaling depend on
      (graceful draining that respects an external grace period, a stable
      multi-worker claim protocol); the platform-level configuration that
      actually invokes them is out of scope, same as every prior phase's
      stated Terraform/Vault non-goals.
- [ ] **A dead-letter queue, or any automated alerting, for poison jobs.**
      The reaper marks them `failed` with a structured reason and logs a
      warning-level line; nothing pages anyone. The runbook documents what
      to watch for manually — a real deployment needs to wire an actual
      alert off either the log line or a `scheduling_jobs_total{status=
      "failed"}` rate, neither of which happens automatically today.
- [ ] **Real metrics/dashboards backend.** Both `/metrics` endpoints emit
      real Prometheus exposition format; there is no Prometheus server,
      Grafana, or alerting rule actually deployed anywhere in this
      environment to scrape/visualize/alert on them. Same "no dashboards
      backend in this repository" posture Module 02's own runbook already
      states.
- [ ] **`pg_partman` or any automated partition-rotation tooling.** A
      pre-existing, separately-tracked gap (ADR-0053) — a job scheduled far
      enough in the future fails closed with a raw Postgres error rather
      than a clean domain error. Flagged in this phase's own runbook,
      not fixed by it.
- [ ] **Multi-region / cross-datacenter worker coordination.** The claim
      protocol assumes every worker instance can reach the same Postgres
      with low, consistent latency — nothing about `FOR UPDATE SKIP LOCKED`
      is unsafe across regions, but claim latency and contention
      characteristics under a genuinely distributed worker fleet have not
      been measured (the load test's own worker count was one).
