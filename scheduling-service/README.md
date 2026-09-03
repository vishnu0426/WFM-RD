# AGNO WFM — Module 04: Scheduling Engine (Python)

Highest engineering-risk module in this platform: a wrong constraint model is
a legal-liability bug, not a UX bug (see the module prompt's §0).

## What's in Phase 1 (schema & job scaffolding)

- Full DDL for every §2 entity (`ScheduleJob`, `Schedule`, `ShiftAssignment`,
  `ScheduleExplanation`, `ScheduleConflict`) plus `idempotency_keys` —
  `migrations/versions/0001_initial_schema.py`.
- RLS on every `scheduling.*` table, reusing Module 01's
  `app.current_tenant_id` GUC unchanged (ADR-0002/0052).
- `shift_assignments` partitioned `RANGE` monthly on `shift_start`
  (ADR-0053) — this module's highest-cardinality table (one row per
  employee per shift).
- `ShiftAssignment.locked` is a Postgres `GENERATED ALWAYS` column derived
  from `assignment_source` (ADR-0054) — the schema itself makes it
  impossible for a locked (human-touched) assignment to silently disagree
  with its own lock status.
- `POST /v1/scheduling/jobs` / `GET /v1/scheduling/jobs/{jobId}` (§4.1),
  `Idempotency-Key` required, standard `{ error: { code, message, details } }`
  envelope, `X-Request-Id`.
- `/healthz` / `/readyz` (Postgres blocking, NATS reported non-blocking).
- NATS JetStream publisher skeleton (`AGNO_SCHEDULING` stream, subject
  `agno.scheduling.job.completed.v1`).

See `../docs/module-04-phase-1-design-doc.md` /
`../docs/module-04-phase-1-production-readiness-checklist.md` for the full
reasoning and honest gap list.

## What's in Phase 2 (hard constraint model, single-site scope)

- **`app/solver/`** — a pure, DB/network-independent CP-SAT engine
  (`ortools`). Every §3.1 hard constraint encoded directly in the model:
  skill requirement + leave/unavailability (eligibility gating — no decision
  variable exists for an ineligible pair), minimum rest between shifts +
  no-double-booking (one pairwise conflict check), maximum consecutive
  working days (rolling-window constraint), contracted hours vs.
  overtime-approval (hard per-calendar-week cap), union rules on shift
  length/mandatory break (pre-solve template validation, not a decision
  variable).
- **§8's constraint-correctness test suite**
  (`tests/unit/test_solver_constraints.py`) — 17 synthetic scenarios, one
  (or a feasible/infeasible pair) per hard constraint, run against the real
  solver.
- **`POST /v1/scheduling/jobs` now actually solves** when the request
  supplies `policy` + `shiftSlots` (`roster`/`leaveRecords` alongside them) —
  synchronously, to a real terminal state: `completed` (a `Schedule` +
  `ShiftAssignment` rows are persisted), `infeasible` (CP-SAT proved no
  solution exists), or `failed` (the solver's time budget expired
  inconclusively — never conflated with `infeasible`). A request without
  `policy`/`shiftSlots` keeps Phase 1's exact behavior.
- **New `GET /v1/scheduling/jobs/{jobId}/schedule`** — reads back the
  persisted schedule + assignments (this service's own minimal REST
  readback; §4.2's GraphQL surface is still Node/Module 01's to build).
- Solve-input data (roster/policy/shifts/leave) is supplied **directly in
  the request body** in this phase, not pulled via gRPC — see
  `../docs/adr/0055-phase-2-solve-input-contract-and-synchronous-solve.md`
  for why, and what Phase 6 changes about it.

See `../docs/module-04-phase-2-design-doc.md` /
`../docs/module-04-phase-2-production-readiness-checklist.md` for the full
reasoning, including two real bugs this phase's own test suites caught and
fixed (a contracted-hours proration bug, and a `locked` column ORM-mapping
bug) — worth reading before assuming any of this is obviously correct on
first read.

## What's in Phase 3 (soft constraints + fairness as a bounded constraint)

- **§3.2's soft constraints, as real objective terms**: employee shift
  preference, cost minimization (overtime + coverage-excess), skill decay
  (prefer fresher proficiency on skill-critical shifts), cross-skill balance
  (spread a required skill across more distinct employees). All four
  independently tenant-configurable and independently switchable off, via
  `constraintConfig.softWeights`.
- **§3.3's fairness bound, as a real hard constraint** — not a tradeable
  objective term, per the module prompt's own explicit instruction. Bounds
  each roster employee's undesirable-shift count (prior *published* history
  + this solve's own assignments) to within a tenant-configured tolerance of
  the roster's own average. Proven capable of making a job genuinely
  infeasible on its own, and proven to span schedule runs end to end (submit
  + publish job A, then show job B's feasibility is governed by job A's
  published history) — see `tests/integration/test_fairness_ledger_api.py`.
- **New `fairness_ledger` table** (migration 0002, partitioned like
  `shift_assignments`) — the `FairnessLedger` cross-run read model the
  module prompt names, refreshed at **publish** time, not solve time.
- **New `POST /v1/scheduling/schedules/{scheduleId}/publish`** — the ledger
  refresh trigger, `draft` → `published` only.
- **New `GET /v1/scheduling/fairness/audit`** — the module prompt's own
  named compliance-auditor query: given a period and a tolerance, every
  employee's undesirable-shift count and whether they exceeded it.
- **`constraintConfig` gets a real validated shape** (`fairness` +
  `softWeights`), fulfilling the promise Phase 1's design doc made about
  this jsonb column's eventual concrete shape.

See `../docs/module-04-phase-3-design-doc.md` /
`../docs/module-04-phase-3-production-readiness-checklist.md` for the full
reasoning, including **five** real bugs this phase's own test suites caught
and fixed — most notably a genuine SQLAlchemy `insertmanyvalues`/`RETURNING`
sentinel-matching failure that turned out to be a *latent Phase 2 bug* too
(ADR-0056), only surfaced once a test finally created 2+ `ShiftAssignment`
rows in one job. Worth reading before assuming any of this is obviously
correct on first read — that's exactly the assumption this phase's own bugs
disproved twice already.

## What's in Phase 4 (infeasibility handling)

- **§5's relaxation search** (`app/solver/relaxation.py`) — when a job comes
  back `infeasible`, tries relaxing §3.1's hard constraints one category at
  a time, cost-ascending (ADR-0057): contracted hours, shift length bounds,
  minimum rest between shifts, maximum consecutive working days. Skill
  requirement, leave/unavailability, shift-overlap prevention, and mandatory
  break placement are **never** relaxed automatically, at any human's
  approval.
- **A structured, queryable result** — `ScheduleJob.relaxations_applied`
  records exactly which categories were tried, whether any combination
  solved, a category-specific cost summary (affected employees/shifts and
  the exact magnitude — additional overtime minutes, actual vs. required
  rest, consecutive days worked vs. allowed), and a generated explanation
  sentence. `ScheduleJob.status` stays `infeasible` regardless — nothing is
  auto-applied, per §5 point 4's non-negotiable.
- **New `POST /v1/scheduling/jobs/{jobId}/relaxation/approve`** — the *only*
  code path in this module that ever turns a relaxation option into a real,
  persisted `Schedule`. No request body: approves exactly what the search
  found and reported, re-solves to re-prove feasibility, and only then
  persists.
- **New `schedule_jobs.solve_input_snapshot`** (migration 0003) — a
  deliberate, narrow exception to ADR-0055's "request-supplied, not
  persisted" posture, populated only for `infeasible` jobs, so approval
  doesn't require the caller to resend the entire original payload.

See `../docs/module-04-phase-4-design-doc.md` /
`../docs/module-04-phase-4-production-readiness-checklist.md` for the full
reasoning, including a real architectural gap found while building this:
`shift_length_bounds` relaxation is correct in isolation but currently
unreachable by the search, since a too-short/too-long shift is rejected at
submission time, before any solve ever runs (ADR-0057).

## What's in Phase 5 (manual override / locked-assignment re-optimization)

- **New `POST /v1/scheduling/schedules/{scheduleId}/assignments/{assignmentId}/override`**
  — reassigns an existing `ShiftAssignment` to a new employee and sets
  `assignment_source: manual_override`; `locked` follows automatically from
  the `GENERATED ALWAYS` column (ADR-0054). No skill/leave/contracted-hours
  re-validation — a human override is trusted, not re-litigated. Detects
  `double_booking` against the employee's other assignments on the same
  schedule and records an open `ScheduleConflict` (this phase's own
  ADR-0058-scoped conflict-detection posture: only what's derivable from
  data this service already persists).
- **New `GET /v1/scheduling/schedules/{scheduleId}/conflicts`** — reads back
  what override just wrote, the first time this table is reachable over
  HTTP at all.
- **`SolveInput.locked_assignments`** (ADR-0058) — §2.2 rule 1 made real:
  every locked pair gets an unconditionally-created decision variable
  (bypassing skill/leave eligibility gating) forced to `1`. Four hard
  constraints gained a matching "effective cap/window" or "skip if both
  sides already fixed" adjustment so a locked fact can never make the whole
  model infeasible on its own — see ADR-0058 for the full per-constraint
  breakdown.
- **New `POST /v1/scheduling/schedules/{scheduleId}/reoptimize`** — a new
  solve, its own `ScheduleJob`, same completed/infeasible/failed/
  relaxation-search machinery as `POST /v1/scheduling/jobs`. Matches
  currently-locked assignments into the resupplied `shiftSlots` by
  `(start, end, requiredSkillId)` (not by id — the original id was never
  persisted); a locked shift or locked employee missing from the resupplied
  request is a real, rejected (`422`) caller error, not a silent drop.
- **A correctness fix, found while wiring this phase up**:
  `approve_relaxation` previously rebuilt its `SolveInput` as a manually-
  enumerated field-by-field literal, which would have silently dropped this
  phase's own `locked_assignments` on a reoptimize-then-approve path. Fixed
  with `dataclasses.replace`, which carries every field forward
  automatically; `solve_input_snapshot`'s serde extended to match.

See `../docs/module-04-phase-5-design-doc.md` /
`../docs/module-04-phase-5-production-readiness-checklist.md` for the full
reasoning, including a real bug this phase's own integration tests caught
(a post-flush access of the `GENERATED ALWAYS` `locked` column raising
`sqlalchemy.exc.MissingGreenlet`) and the explicit assumption that
reoptimizing never auto-archives the schedule it reoptimized from — a real,
currently-open gap, not a deferred nice-to-have.

## What's in Phase 6 (mid-solve gRPC data pulls + explanation-generation trigger)

- **`ScheduleJobRequest.roster`/`.policy`/each shift's `requiredHeadcount`
  are now independently optional.** Omitted → pulled via gRPC from the real
  running Module 01/02 (`EmployeeService`/`PolicyService`) and Module 03
  (a new `ForecastService`, built this phase). Supplied → used exactly as
  given, never merged with a pull — the same trust-the-caller posture
  ADR-0058 already used for manual assignment overrides, applied here to
  whole-input overrides.
- **New `app/grpc_clients/` package**: real clients for
  `GetSchedulableEmployees`/`GetEmployeeSkillMatrix`/`GetActivePolicy`/
  `GetForecastRequirements`, plus a shared retry/backoff helper (§4.3: "a
  transient gRPC failure mid-solve should retry the specific data call, not
  abort the whole solve job" — up to 4 attempts, 100/400/1600ms backoff,
  retrying only `UNAVAILABLE`/`DEADLINE_EXCEEDED`). Exhausting retries never
  creates a `ScheduleJob` row — `503 UPSTREAM_DATA_UNAVAILABLE`, raised
  before any persistence, so a retried request with the same
  `Idempotency-Key` is a fresh attempt.
- **A new real gRPC surface in `forecasting-service` itself** -
  `ForecastService.GetForecastRequirements`, since it didn't exist before
  this phase needed it. Reads Phase 5's already-computed
  `ForecastDataPoint.required_headcount`; an omitted shift headcount is
  derived as the **max** across every forecast interval the shift's own
  window overlaps (peak staffing, not average) - undeterminable is a loud
  `422 SHIFT_HEADCOUNT_UNDETERMINED`, never a guess.
- **`agno.scheduling.job.completed.v1` actually publishes now** -
  Phase 1's scaffolded-but-never-called `publish_job_completed` is wired
  into every terminal solve outcome (`completed`/`infeasible`/`failed`)
  across `create_job`/`approve_relaxation`/`reoptimize_schedule`.
- **New `POST /v1/scheduling/jobs/{jobId}/explanation`** (upserts) +
  `explanation` folded into `GET /v1/scheduling/jobs/{jobId}` — the
  write/read halves of the Module 10 handoff (§1: "Module 04 requests it,
  doesn't own the LLM call"). `explanation` stays `null` until something
  outside this repo actually subscribes to the completion event and calls
  back — this module never generates one itself.
- **Five real bugs found and fixed outside this module's own code** while
  getting real infrastructure running for verification — two in Module
  01/02 that blocked its gRPC server (and, for one of them, the entire
  app) from booting at all, one in `forecasting-service`'s own Alembic
  config nearly corrupting *this* module's migration-tracking table, one
  more in Module 01/02's own TypeORM tracking table, and a missing CHECK
  constraint widening in `core.policies`. None of them Module 04's to own
  long-term — see the design doc/checklist for the full list and who
  actually owns each fix going forward.

See `../docs/module-04-phase-6-design-doc.md` /
`../docs/module-04-phase-6-production-readiness-checklist.md` for the full
reasoning, including the explicit `protobuf` version-override assumption
(`grpc_tools.protoc`'s generated code needs newer protobuf than `ortools`
declares support for — verified working in practice, not just asserted) and
what's still genuinely open (Module 01/02's migration-tracking corruption
isn't fully re-baselined, the employment-policy JSON contract has no
enforcement on the writing side, `Employee.overtime_approved` has no source
anywhere in the platform).

## What's in Phase 7 (decomposition + load testing at scale)

- **`app/solver/decomposition.py`** — large jobs (>200 employees) split by
  each shift's own `orgUnitId` into independently-solvable per-site
  sub-problems, with a union-find coupling-merge for skills no single
  site's home pool can locally cover (never a lightweight "patch after the
  fact" coordination pass — see ADR-0061 for why that's a harder problem
  than it looks). Below the threshold, or when site information is missing/
  ambiguous, decomposition is a deliberate no-op — every pre-Phase-7 job
  behaves exactly as before.
- **`app/solver/commercial_fallback.py`** — a precisely defined trigger
  (`status: "unknown"` on a >300-employee sub-problem) for when CP-SAT alone
  isn't enough; honestly not wired to a real Gurobi/CPLEX license, since
  none exists in this environment. Fails loudly and diagnosably rather than
  faking a substitution.
- **A real bug found and fixed this phase**: `Employee.org_unit_id` was
  never populated by either roster path (the explicit-roster schema had no
  field for it; the gRPC-pull client discarded the response's own field) —
  meaning any job that actually crossed the decomposition threshold would
  have silently produced zero-employee groups and falsely reported
  infeasible. Fixed in `EmployeeInput`/`to_employee`/
  `employee_client.get_schedulable_roster`.
- **A real, run-for-real load test** (`scripts/load_test_decomposition.py`)
  at 100,000 employees / 500 sites — against a real Postgres, a real
  `python -m app.worker` subprocess, real CP-SAT solves. See
  `../docs/module-04-phase-7-load-test-results.md` for the actual measured
  numbers (not a claim: ~17s total wall time, ~7.9s of summed CP-SAT time
  across 500 trivially-easy sub-problems, the remainder being a real,
  flagged `O(sites × employees)` orchestration-overhead characteristic).

See `../docs/module-04-phase-7-design-doc.md` /
`../docs/module-04-phase-7-production-readiness-checklist.md` for the full
reasoning.

## What's in Phase 8 (async worker pool, zero-downtime deploy, observability)

- **A real, separate `app/worker.py` process** — `SELECT ... FOR UPDATE
  SKIP LOCKED` claim against `schedule_jobs` itself (not a second NATS work
  queue — see ADR-0060 for why that risks dual-write drift), `job_kind`
  dispatch (`submit`/`relaxation_approval`/`reoptimize`) unifying three
  previously-separate synchronous code paths, graceful `SIGTERM`/`SIGINT`
  draining that always finishes an in-flight claim before stopping, and a
  reaper sweep that requeues jobs stuck in `solving` and marks poison jobs
  (past `maxAttempts`) `failed` instead of retrying forever.
- **A real, acknowledged breaking API change**: `POST /v1/scheduling/jobs`
  (and reoptimize, and relaxation-approve) now only enqueue — every response
  is `status: queued`, never a terminal outcome. Poll `GET /{jobId}` for the
  real result. Every pre-Phase-7 integration test was rewritten to poll
  (`poll_until_terminal`), not weakened to stop checking.
- **A real, acknowledged semantic change**: validation errors that used to
  be synchronous 4xx/503/409 responses during solving now surface as an
  async `failed` job with a structured `relaxationsApplied.failureReason` -
  there's no HTTP response left to attach them to once solving moves off
  the request thread. Enqueue-time checks that don't require solving stay
  synchronous.
- **Migration `0004`**: `job_kind`/`request_payload`/`target_schedule_id`/
  `claimed_by`/`solving_started_at`/`attempt_count` on `schedule_jobs`, plus
  a narrowly-scoped platform-admin RLS bypass on that one table (mirrors
  Module 01/02's own `core.tenants` policy pattern).
- **Two Prometheus surfaces** (`/metrics` on the API process,
  `WORKER_METRICS_PORT` on each worker) — queue depth, solve duration by
  scope-size bucket, jobs by terminal status, relaxation-category frequency.
  "Infeasible rate by org unit" is deliberately structured JSON logging, not
  an unbounded-cardinality Prometheus label.
- **`docs/module-04-runbook.md`** — queue-depth diagnosis, stuck-job
  recovery, worker scaling/shutdown, decomposition-outcome diagnosis.

See `../docs/module-04-phase-8-design-doc.md` /
`../docs/module-04-phase-8-production-readiness-checklist.md` for the full
reasoning, including the architectural fork resolved by asking rather than
guessing (pulling the async worker pool forward into Phase 7 rather than
building decomposition against the old synchronous path first).

**Still not built, on purpose:** any real commercial-solver integration,
true cross-worker parallel execution of one job's decomposed groups,
`pg_partman`/automated partition rotation (a load-bearing gap this phase's
own load test hit directly), `skill_gap`/`leave_overlap`/`overtime_breach`
conflict detection (still needs data this platform has nowhere to pull
from), any schedule-versioning/archival lifecycle, forecast-pull support
for reoptimize, any actual Kubernetes/CI-CD wiring for the zero-downtime
mechanics this phase built.

## Post-Phase-8 addition: Module 10's `ScheduleExplanationDataService` (docs/adr/0115)

Module 10 (AI Layer, `../ai-layer-service`) started its own Phase 2 build
against this module's spec'd-but-never-built read contract for
`explainSchedule` and found it didn't exist anywhere in this repo — Phase
6's own handoff only ever built the write half
(`POST /v1/scheduling/jobs/{jobId}/explanation`). `ScheduleExplanationDataService.GetScheduleJobForExplanation`
(`app/grpc/proto/schedule_explanation_data.proto`, `app/grpc/schedule_explanation_data_grpc_server.py`)
closes that gap — this service's third gRPC servicer, same process/port as
`SchedulingEligibilityService`/`ScheduleQueryService`, a plain by-id read
of `ScheduleJob`'s own solve-result columns
(`status`/`objective_score`/`relaxations_applied`/`decomposition_plan`).
Echoes `tenant_id` from the persisted row (not just the request's own
field) specifically so the caller's own tenant-scoping assertion has
something real to check against. See ADR-0115 for the full reasoning and
ADR-0116 for a real `generatedByModelId` contract mismatch this addition
surfaced (this module's schema assumes a uuid-keyed AI-model registry that
doesn't exist anywhere in this platform — Module 10 always sends `null`
for it, disclosed rather than faked).

## Entity relationships

```
ScheduleJob (1) ──< Schedule (1) ──< ShiftAssignment
                         │
                         └──< ScheduleConflict
ScheduleJob (1) ── ScheduleExplanation (0..1)
```

No foreign key crosses a schema boundary: `ScheduleJob.forecast_run_id`,
`ShiftAssignment.employee_id`/`skill_id`, and
`ScheduleConflict.affected_employee_id` are plain `uuid` columns — Module
01/02/03's data is reached exclusively through gRPC contracts (real as of
Phase 6 — `app/grpc_clients/`), never by reading `core.*`/`org.*`/
`forecasting.*` directly (ADR-0052).

## Getting started

```bash
# From the repo root - shared docker-compose with Module 01/02/03, reuses
# the same NATS JetStream broker Module 03 already runs.
docker-compose up -d
cp scheduling-service/.env.example scheduling-service/.env

cd scheduling-service
python -m venv .venv && .venv/Scripts/activate   # source .venv/bin/activate on macOS/Linux
pip install -e ".[dev]"

alembic upgrade head        # applies migrations/versions, connects as agno_migrator
ruff check .                 # lint
mypy app                     # typecheck
pytest tests/unit            # unit tests, no DB/NATS required
pytest tests/integration     # requires docker-compose up + migrations applied
uvicorn app.main:app --reload --port 8100   # the API process - enqueues only, as of Phase 8
python -m app.worker                         # the worker process - does the actual solving
```

**As of Phase 8, `uvicorn` alone does not solve anything.** `POST
/v1/scheduling/jobs` returns `status: queued` immediately; at least one
`python -m app.worker` process must also be running against the same
Postgres for any job to ever leave `queued`/`solving`. Run more than one
`app.worker` instance for more solve throughput - no coordination needed
beyond both pointing at the same `DB_*` (see `../docs/module-04-runbook.md`).
Give each concurrent local instance its own `WORKER_METRICS_PORT`.

**Testing against an existing/shared Postgres instead of `docker-compose`'s
local one**: point `.env`'s `DB_HOST`/`DB_PORT`/`DB_DATABASE` at it and, as
the instance's superuser (or an existing `agno_migrator`-equivalent), run
just the `agno_scheduling_app` role + `scheduling` schema block from
`scripts/init-roles.sql` (skip the rest if Module 01/02/03 already
provisioned it — the whole file is additive/idempotent-by-inspection). Then
`alembic upgrade head` as normal. This is exactly how every phase of this
module was actually verified end-to-end (a real shared Postgres, a real
local NATS+JetStream broker) — not just unit-tested.

**Phase 6's gRPC pulls, tested against the real upstream services**: set
`CORE_GRPC_URL`/`FORECASTING_GRPC_URL` (defaults `localhost:5000`/
`localhost:6000`) to point at real running instances -

```bash
# Module 01/02 (repo root) - GRPC_URL defaults to :5000; macOS's AirPlay
# Receiver squats on that port by default, so this session used :5001.
npm run migration:run
GRPC_URL=0.0.0.0:5001 npm run start:dev

# forecasting-service - the standalone gRPC-only runner, not the full
# app.main (which needs this service's full ML stack installed just to
# import). See that file's own docstring.
cd forecasting-service && alembic upgrade head
python run_grpc_server_standalone.py
```

Every test in `tests/unit`/`tests/integration` except
`test_grpc_data_pulls_api.py` runs with no live upstream at all (the pull
only ever fires when a request omits `roster`/`policy`/a shift's
`requiredHeadcount`, and no other test does).

## Scripts (no `package.json` here — direct commands)

| What | Command |
|---|---|
| Apply / roll back migrations | `alembic upgrade head` / `alembic downgrade -1` |
| Lint | `ruff check .` |
| Typecheck | `mypy app` |
| Unit tests | `pytest tests/unit` |
| Integration tests | `pytest tests/integration` (needs Postgres + NATS up, migrations applied) |
| Run the API process | `uvicorn app.main:app --reload --port 8100` (enqueues only, as of Phase 8) |
| Run a worker process | `python -m app.worker` (does the actual solving - run 1+) |
| Decomposition load test | `python scripts/load_test_decomposition.py [--sites N] [--employees-per-site N]` |

## Capacity planning (§0.5)

A real 100k+ employee load test now exists (Phase 7,
`scripts/load_test_decomposition.py`,
`../docs/module-04-phase-7-load-test-results.md`) — measured numbers below
are from that run, not sizing assumptions. Everything else in this section
remains provisional:

- **`shift_assignments` write volume**: one row per employee per shift,
  regenerated on every re-optimization. At 100k+ employees this is this
  module's `audit_log`/`forecast_data_points` analogue — the reason
  ADR-0053 partitions it by `shift_start` from Phase 1, before any row
  exists.
- **`schedule_jobs`/`schedules`/`schedule_conflicts`/`schedule_explanations`**
  are bounded by solve/publish/conflict frequency, not employee count — left
  unpartitioned, same reasoning ADR-0018 gave for `forecast_models`/
  `forecast_runs`.
- **CP-SAT model construction is `O(employees × shifts²)` per employee**
  (the pairwise no-conflict/no-double-booking check), joined in Phase 3 by
  the fairness constraint's own `O(employees)` terms — this is exactly why
  Phase 7 decomposes above 200 employees rather than handing one monolithic
  model to CP-SAT at real scale.
- **Decomposition's own group-materialization pass is `O(sites × employees)`**
  (`app/solver/decomposition.py::_materialize_groups` filters the full
  employee list once per resulting group) — a real, measured cost at
  100k-employee/500-site scale (~7.7s of ~17s total wall time, per the load
  test report), not a hypothetical. Flagged, not yet fixed — no scale this
  module has been asked to handle has proven an index-based rewrite
  necessary yet.
- **`fairness_ledger` write volume** mirrors `shift_assignments` (one row
  per employee per *published* shift) — same partitioning reasoning
  (ADR-0053), same "no production partition rotation yet" gap.
- **Connection pooling**: `app/db/session.py` creates one `AsyncEngine` per
  process with `pool_pre_ping=True`; no PgBouncer modeled in
  `docker-compose.yml`, same local-dev-only posture every prior module's
  Phase 1 already documented.
- **Solve-time SLO** is explicitly not a single number per §0.5 ("a single
  flat 'solve SLO' for this module is meaningless"). Solving moved off the
  request thread entirely in Phase 8 (a real async worker pool) - the
  synchronous-solving gap every prior phase's checklist flagged is closed;
  `WORKER_REAPER_STUCK_THRESHOLD_SECONDS` (default 300s) is the operational
  number that now needs tuning against real p99 solve time instead.
- **Phase 4's relaxation search adds up to 4 additional solves** to an
  infeasible job - now additional worker-side solves within the same claim,
  not additional latency on a blocked HTTP connection.

## Testing strategy

- **Unit** (`tests/unit/`): `TenantContext` fail-closed + `contextvars`
  isolation, the error envelope shape, `TenantContextMiddleware`/
  `RequestIdMiddleware` behavior on a minimal app (no DB, no NATS),
  `ScheduleJobRequest`/`DateRange` Pydantic validation, Phase 2's §8
  constraint-correctness suite (17 scenarios against the real CP-SAT solver,
  no DB/HTTP involved — `app/solver/` is deliberately import-independent of
  both), Phase 3's own solver-level suite
  (`tests/unit/test_solver_soft_constraints_and_fairness.py`) proving each
  soft term actually changes the chosen solution and that the fairness bound
  can force infeasibility, and Phase 4's relaxation-search suite
  (`tests/unit/test_solver_relaxation.py`) proving the cost-ascending search
  reaches each category in turn and that skill requirement can never be
  talked down, Phase 5's locked-assignment suite
  (`tests/unit/test_solver_locked_assignments.py`, 11 scenarios: forcing,
  eligibility bypass, unknown-reference validation, locked-locked conflict
  skip, locked-vs-solvable conflict still enforced, effective-cap/window
  adjustment for both contracted hours and max consecutive days), a
  byte-for-byte `SolveInput` serialize/deserialize round-trip test
  (`test_solve_input_serde.py`, now covering `locked_assignments` too), and
  Phase 6's retry/backoff suite (`test_grpc_retry.py`, 5 scenarios against
  real `grpc.aio.AioRpcError` instances with `asyncio.sleep` monkeypatched
  out so it runs instantly).
- **Integration** (`tests/integration/`, requires `docker-compose up` +
  migrations applied): RLS isolation both under the application guard and
  with it bypassed entirely, a real assertion that `agno_scheduling_app`
  cannot read `core`/`forecasting`, a real assertion that `locked` rejects a
  direct write attempt (ADR-0054), the full Phase 1 `POST`/`GET` job
  contract, Phase 2's full solve-to-persisted-schedule flow over HTTP
  (feasible, infeasible, overtime attribution, skill/leave gating,
  union-rule-violation rejection + idempotency-key retry after rollback),
  Phase 3's publish flow + cross-run fairness enforcement + compliance-
  auditor query against the real, persisted `FairnessLedger`, and Phase 4's
  full infeasible → relaxation-recorded → approve → real-schedule flow
  (plus double-approval, approving a feasible job, and approving an
  unwinnable job all correctly rejected), and Phase 5's override +
  reoptimize flow end to end (an override survives a reoptimize with its
  `assignmentSource` intact while the rest of the schedule re-solves
  freely, a double-booking override is detected and readable back via the
  conflicts endpoint, a locked shift/employee missing from a reoptimize
  request is rejected, reoptimize replays idempotently, overriding a
  nonexistent assignment 404s), and Phase 6's gRPC data pulls end to end
  against the real running Module 01/02 app and a real `ForecastService`
  (omitted roster/policy pulled and solved correctly; omitted shift
  headcount derived from the forecast's peak interval; an explicit
  roster/policy winning over a decoy pull target; a nonexistent forecast
  run rejected with `422`), plus the completion-event publish (a real
  message received off a real NATS JetStream stream within the same test
  that triggered it) and the explanation submit/read/upsert/404 flow, and
  Phase 7/8's own dedicated mechanics suite
  (`test_worker_and_reaper.py`): concurrent claims against the same queue
  never double-claim a row (`FOR UPDATE SKIP LOCKED` proven directly, via
  `asyncio.gather` racing two claimers), the reaper requeues a stuck job
  and poison-fails one past `maxAttempts`, `Worker.request_drain()`
  genuinely causes the run loop to return, and a real >200-employee,
  2-site job decomposes into independent groups and gets both sites'
  shifts covered end to end over HTTP. Every pre-Phase-7 integration test
  file rewritten to poll for the real terminal outcome
  (`poll_until_terminal`), since `POST` now only ever returns `queued`.
- **Load/scale testing**: `scripts/load_test_decomposition.py`, run for
  real at 100,000 employees/500 sites - not a pytest suite (it drives a
  real worker subprocess and takes tens of seconds), see
  `../docs/module-04-phase-7-load-test-results.md` for the actual numbers.

## Documentation index

- `../docs/module-04-phase-1-design-doc.md` /
  `../docs/module-04-phase-1-production-readiness-checklist.md`
- `../docs/module-04-phase-2-design-doc.md` /
  `../docs/module-04-phase-2-production-readiness-checklist.md`
- `../docs/module-04-phase-3-design-doc.md` /
  `../docs/module-04-phase-3-production-readiness-checklist.md`
- `../docs/module-04-phase-4-design-doc.md` /
  `../docs/module-04-phase-4-production-readiness-checklist.md`
- `../docs/module-04-phase-5-design-doc.md` /
  `../docs/module-04-phase-5-production-readiness-checklist.md`
- `../docs/module-04-phase-6-design-doc.md` /
  `../docs/module-04-phase-6-production-readiness-checklist.md`
- `../docs/module-04-phase-7-design-doc.md` /
  `../docs/module-04-phase-7-production-readiness-checklist.md`
- `../docs/module-04-phase-8-design-doc.md` /
  `../docs/module-04-phase-8-production-readiness-checklist.md`
- `../docs/module-04-phase-7-load-test-results.md`
- `../docs/module-04-runbook.md`
- `../docs/adr/0052-scheduling-schema-shared-db-separate-role.md`
- `../docs/adr/0053-shift-assignments-partitioning.md`
- `../docs/adr/0054-shift-assignment-locked-generated-column.md`
- `../docs/adr/0055-phase-2-solve-input-contract-and-synchronous-solve.md`
- `../docs/adr/0056-raw-text-insert-for-composite-pk-partitioned-tables.md`
- `../docs/adr/0057-relaxation-categories-and-ordering.md`
- `../docs/adr/0058-locked-assignment-reoptimization-semantics.md`
- `../docs/adr/0059-phase-6-grpc-data-pull-architecture.md`
- `../docs/adr/0060-phase-7-8-async-worker-pool-architecture.md`
- `../docs/adr/0061-phase-7-decomposition-and-commercial-fallback.md`
- `../docs/adr/0115-schedule-explanation-data-grpc-surface-added-to-scheduling-service.md`
  (Module 10's own ADR — the read half of the Phase 6 explanation handoff,
  added post-hoc to this service)
- `../docs/adr/0116-generated-by-model-id-contract-mismatch-disclosed-not-fabricated.md`
