# Module 04 Phase 7 Production Readiness Checklist

Same honesty bar as every prior phase's checklist. This module carries the
platform's highest engineering risk (§0) — a scale-related bug here (a
silently-dropped shift, a falsely-infeasible decomposed job) is as serious
as a constraint-model bug, since it produces a wrong schedule with no
warning, not a visible error.

## Delivered in this phase (application code)

- [x] `app/solver/decomposition.py`: per-site (`ShiftSlot.org_unit_id`)
      partitioning with a `DECOMPOSITION_EMPLOYEE_THRESHOLD` (200) no-op
      floor, union-find coupling-merge for skills no single site's home
      pool can locally cover, and a safe "don't decompose" fallback when
      site information is missing or ambiguous (never a silent-drop
      fallback).
- [x] `app/solver/commercial_fallback.py`: a precisely defined trigger
      (`status == "unknown"` on a >300-employee sub-problem) that raises a
      diagnosable error rather than faking a substitution — honestly not
      wired to a real Gurobi/CPLEX license, since none exists in this
      environment.
- [x] `job_service._decompose_solve_persist`: the shared execution path
      every `submit`/`relaxation_approval`/`reoptimize` job now routes
      through, including per-group relaxation search on a decomposed
      infeasible job (aggregated into a union of attempted categories, with
      `costSummary`/`explanation` kept flat for the common single-group case
      and nested per-`groupId` only when genuinely decomposed) and a
      synthetic merged `SolveResult` reused against the *original*,
      undecomposed `SolveInput` for persistence (no "merged" SolveInput
      needs reconstructing, since decomposition partitions but never drops).
- [x] `decompositionPlan` on `GET /{jobId}` (`decomposed`, `groupCount`,
      per-group `groupId`/`orgUnitIds`/`employeeCount`/`shiftCount`/
      `status`/`solveDurationMs`) — real, inspectable output, not an
      internal detail with no external surface.
- [x] A real bug found and fixed this phase: `Employee.org_unit_id` was
      never populated by either roster path (explicit-roster JSON schema
      had no field for it; the gRPC-pull client discarded the response's
      own field) — meaning any job that actually crossed the decomposition
      threshold would have produced zero-employee groups and falsely
      reported infeasible. Fixed in `EmployeeInput`/`to_employee`/
      `employee_client.get_schedulable_roster`; see the design doc for the
      full account and `test_worker_and_reaper.py` for the regression test
      that would have caught it.
- [x] A real, run-for-real load test (`scripts/load_test_decomposition.py`)
      at both a smoke scale (303 employees/3 sites) and the §7.1-mandated
      scale (100,000 employees/500 sites) — against a real Postgres, a
      real `python -m app.worker` subprocess, real CP-SAT solves, and real
      persisted `ShiftAssignment` rows, not a synthetic benchmark or a
      typed-in number. Results, including a genuine `O(sites × employees)`
      scaling characteristic the run itself surfaced, recorded in
      `docs/module-04-phase-7-load-test-results.md`.
- [x] `ruff`/`mypy --strict` clean across every new/touched file.
      132 tests (unit + integration) passing against real Postgres/NATS,
      including 7 new dedicated tests directly proving decomposition,
      concurrent claim exclusivity, reaper requeue/poison-fail, and
      graceful-drain semantics (`test_worker_and_reaper.py`) — not only
      indirectly inferred from a job's eventual outcome.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Any commercial-solver integration.** The trigger point is real and
      precisely defined; there is no Gurobi/CPLEX license in this
      environment to actually fall back to. A job that hits this trigger
      today fails cleanly with a diagnosable reason — it does not silently
      produce a worse-but-plausible-looking schedule.
- [ ] **True cross-worker parallel execution of one job's decomposed
      groups.** Sequential within a single worker's claim, by deliberate
      design (this phase's actual problem was tractability, not wall-clock
      parallelism) — a documented future enhancement, not started.
- [ ] **Fixing `_materialize_groups`'s `O(sites × employees)` scaling.** A
      real, measured cost (~7.7s of a ~17s total wall time at 100k
      employees/500 sites) — flagged in the load test report and design
      doc rather than silently optimized away, but not fixed, since no
      scale this module has actually been asked to handle has proven it a
      genuine bottleneck yet. An index-based rewrite is the documented next
      step if a future load test at larger scale shows it becomes one.
- [ ] **Automated partition rotation (`pg_partman` or equivalent).** A
      pre-existing gap (ADR-0053) this phase's own load test hit directly
      on its first run (a far-future test date failed closed with a raw
      Postgres error rather than a domain error) — documented in the
      runbook, not fixed, since it was explicitly out of scope for the
      migration that created the partitioning scheme in the first place.
- [ ] **Load testing against a *hard*, skill-constrained shift mix.** This
      phase's load test deliberately used trivial per-site shifts (1 shift,
      `requiredHeadcount: 1`, no skill requirement) to isolate and measure
      decomposition/orchestration overhead specifically. A workload with
      many hard, skill-gated shifts per site at the same scale would likely
      be dominated by CP-SAT time instead, and has not been measured here.
