# Module 04 Phase 7 Design Doc — Scheduling Engine: Decomposition at Scale

**Status:** Approved for implementation
**Owner:** Scheduling pod (Module 04) — Principal Operations Research Engineer
**Scope:** §7.1's decomposition strategy for large multi-site solves, the
commercial-solver-fallback trigger point, and a real, run-for-real load test
at 100k+ employees. Builds directly on the async worker pool this phase
required pulling forward from Phase 8 (see "A scope fork resolved by asking,
not guessing" below) — decomposition's whole premise is "split a large solve
into independently-solvable pieces," which only matters if something can run
those pieces without blocking an HTTP request for however long the largest
one takes.

## Problem

Phase 2's own checklist already flagged this honestly: the pairwise
no-conflict constraint construction is `O(employees × shifts²)` per
employee, untested past small synthetic scenarios, with "no load test, no
decomposition, no data point on where this stops being single-site scope."
The module prompt's own 100k+-employee framing (§0) makes clear this isn't
hypothetical — a real deployment needs a defined answer for "what happens
when one job's scope is genuinely too large for one CP-SAT model," and that
answer has to be *proven*, not asserted, per §0.5's "no vague sufficiency
claims" rule.

## A scope fork resolved by asking, not guessing

Before writing any decomposition code, planning Phase 7/8 together surfaced
a real architectural fork: §7.2 (Phase 8)'s graceful-draining/reaper design
presupposes a real async worker pool exists to drain/reap — but the actual
implementation through Phase 6 had solved synchronously, inline in the HTTP
request, since Phase 2 (a stated, accepted gap in every prior phase's
checklist). Two honest options existed: (1) build decomposition against the
*existing* synchronous path, leaving Phase 8's draining/reaper as
near-no-ops against a queue that (almost) never holds anything, or (2)
pull the async worker pool forward into this phase, so decomposition has a
genuine place to run without blocking a request, and Phase 8's own
mechanics become meaningful rather than vestigial. This is a real trade-off
(larger blast radius, a genuine breaking API response-shape change) that
the module prompt's own protocol calls for surfacing rather than silently
picking — asked via `AskUserQuestion`; the answer was option 2, build the
real async worker pool now. See `docs/module-04-phase-8-design-doc.md` for
that architecture in full (ADR-0060) — this document assumes it as given
context and focuses on what's genuinely Phase 7's own content.

## Decision

**Decompose by site, not by employee count alone.** `app/solver/
decomposition.py::decompose(SolveInput) -> list[DecompositionGroup]`
partitions by each shift's own `org_unit_id` — the natural
independently-schedulable unit (a store, a site, a facility), not an
arbitrary chunk size. Below `DECOMPOSITION_EMPLOYEE_THRESHOLD` (200
employees), decomposition is a deliberate no-op — every job below this
threshold (every job in every prior phase's test suite, and the overwhelming
majority of real single-site submissions) behaves byte-for-byte as before.
A job above the threshold whose shifts span fewer than 2 distinct
`org_unit_id` values, or where *any* shift is missing one, also doesn't
decompose — decomposing on incomplete site information risks silently
dropping that shift's coverage from every group, and "don't decompose" is
always a safe fallback (worse performance, never worse correctness) where
"guess and drop coverage" is not.

**Coupling detected per-skill, resolved by merging sites (union-find), not a
coordination pass.** A skill required at two or more sites, where any one of
those sites' own home-employee pool can't locally cover its own requirement
for that skill, means those sites can't be solved fully independently — the
solution genuinely depends on employees crossing site boundaries. The
alternative considered and rejected: a lightweight "coordination pass" that
solves sites independently first and then patches shortfalls after the
fact. Rejected because patching after the fact is a materially *harder*
second-solve problem than this phase's actual need (it has to reconstruct
which assignments to undo, verify no new hard-constraint violation gets
introduced by the patch, and iterate if the patch itself doesn't fully
close the gap) — merging into one larger sub-problem up front is
conservative (a merged group's feasible region is a strict superset of the
independent ones'), correct by construction, and no harder to implement
than the detection itself.

**Sequential, not distributed, sub-problem execution within one worker's
claim.** Each decomposed group solves one after another inside the same
`app.worker` claim that pulled the whole job. This was a deliberate choice,
not a shortcut: the problem this phase actually needed to solve is CP-SAT
*tractability* (keeping any single model small enough to solve well), not
wall-clock parallelism. True cross-worker parallel execution of a single
job's decomposed groups is a real, valuable future enhancement, but it's a
different problem (job-level fan-out/fan-in coordination) than what this
phase needed to prove correct today — flagged explicitly rather than
half-built.

**Commercial-solver fallback: a precisely defined trigger, honestly not
wired to a real solver.** `app/solver/commercial_fallback.py::
should_trigger_commercial_fallback` fires when a group's own `SolveResult
.status == "unknown"` (CP-SAT exhausted its time budget with neither a
solution nor a proof of infeasibility) on a sub-problem with more than
`COMMERCIAL_FALLBACK_EMPLOYEE_THRESHOLD` (300) employees — a concrete,
measurable condition, not a vague "if the solver seems stuck." There is no
Gurobi/CPLEX license available in this environment, so triggering it raises
`CommercialFallbackRequiredError` with an honest, diagnosable message
(caught by `job_service.execute_job`, resolves the job `failed` with a
structured reason) rather than silently substituting a worse fallback or
pretending the job succeeded. This is the module prompt's own §0
non-negotiable applied to the solver-selection layer, not just the
constraint model: don't fake sufficiency.

## A real bug found and fixed during this phase

Building the actual end-to-end decomposition test (submit a real
>200-employee, multi-site job over HTTP and confirm both sites' shifts get
covered) surfaced that `Employee.org_unit_id` — the field
`_materialize_groups` filters employees by to build each group — was never
populated by *either* roster path. `EmployeeInput` (the explicit-roster
request schema) had no `orgUnitId` field to set it at all; the gRPC-pull
path (`employee_client.get_schedulable_roster`) discarded the response's own
`SchedulableEmployee.org_unit_id` field entirely when building `Employee`
objects. The practical consequence: any job that actually crossed the
decomposition threshold with real multi-site shifts would have produced
groups with **zero employees each** — every shift in every group would have
come back structurally uncoverable, and the job would have falsely reported
infeasible (or triggered a doomed relaxation search) even though the exact
same input, solved as one monolithic model, was perfectly feasible. This
would have been invisible in code review (decomposition.py's own logic is
correct — it's the two callers upstream of it that never supplied the field
it depends on) and would only have surfaced the first time a real deployment
crossed the 200-employee/multi-site threshold in production. Found by
building the test this phase's own "not a verbal claim" load-testing
posture demanded, not by inspection. Fixed in three places: `EmployeeInput`
gained an `orgUnitId` field (`app/api/v1/schemas.py`, mirroring
`ShiftSlotInput`'s own), `solve_input_conversion.to_employee` threads it
through, and `employee_client.get_schedulable_roster` now reads the
response's own `org_unit_id` field instead of discarding it. Covered going
forward by `tests/integration/test_worker_and_reaper.py::
test_decomposition_splits_a_large_multi_site_job_and_covers_both_sites`.

## The load test, run for real

`scripts/load_test_decomposition.py` — not a unit test with a mocked solver,
not a number typed into this document without having run anything. Submits
a real HTTP request (in-process `TestClient`, but the same FastAPI app and
Pydantic validation a real deployment runs) to a real local Postgres, with a
real `python -m app.worker` subprocess doing the actual claim/decompose/
solve/persist/publish work, and polls to a genuine terminal status. Results
for the two runs actually executed this phase — 303 employees/3 sites (a
smoke-scale sanity check) and 100,000 employees/500 sites (the §7.1-mandated
scale) — are recorded in full, with real measured numbers, in
`docs/module-04-phase-7-load-test-results.md`. Headline result: the
100k-employee run completed in ~17s wall time, with ~7.9s of that being
summed CP-SAT time across 500 trivially-easy per-site sub-problems and the
remainder being decomposition/orchestration overhead — see that document's
own "Interpretation" section for the specific `O(sites × employees)`
scaling characteristic this run surfaced in `_materialize_groups` (flagged,
not silently optimized away, since a fix wasn't necessary to pass this
phase's own load-test bar and a fix without a measured problem would be
speculative engineering).

## Blast radius

- New: `app/solver/decomposition.py`, `app/solver/commercial_fallback.py`,
  `scripts/load_test_decomposition.py`, `docs/module-04-phase-7-load-test-
  results.md`.
- Extends `Employee`/`ShiftSlot` (both gained `org_unit_id: uuid.UUID |
  None = None`) and `EmployeeInput`/`ShiftSlotInput` (both gained the
  corresponding `orgUnitId`, also `None`-default) — every pre-Phase-7
  caller's exact prior behavior is preserved, since `None` means "never
  participates in decomposition grouping," not an error.
- `job_service._decompose_solve_persist` is the one new integration point:
  every `submit`/`relaxation_approval`/`reoptimize` execution path now
  routes through `decompose()` first (a no-op below the threshold) rather
  than calling `solve()` directly on the whole input.
- No schema/migration changes of its own in this phase — `decomposition_plan`
  (the jsonb column read back in `GET /{jobId}`) already existed on
  `schedule_jobs` from Phase 1, unused until now.

## Explicit assumptions (spec was ambiguous or silent here)

1. **"Site" means `ShiftSlot.org_unit_id`, not `ScheduleJobRequest
   .org_unit_id`.** The request's own top-level `orgUnitId` is a single
   value; decomposition needs multiple values to have anything to split on,
   so it necessarily reads from each shift's own field instead. A caller
   that wants decomposition to ever trigger has to set `orgUnitId` on
   individual `shiftSlots`/`roster` entries, not just the request envelope —
   a real, load-bearing distinction worth calling out explicitly since the
   two fields share a name.
2. **The gRPC-pull roster path's `org_unit_id` is trusted as-is from
   `SchedulableEmployee`, not re-derived.** If Module 02's own employee
   record disagrees with which site an employee "really" belongs to for
   scheduling purposes, that's a data-quality question upstream of this
   module, not something Phase 7 second-guesses.
3. **A merged (coupled) group is exactly as large as the union of its
   member sites — no partial/proportional splitting.** ADR-0061's
   documented trade-off: conservative and correct, not minimal.
4. **The load test's own shift design (1 trivial shift per site,
   `requiredHeadcount: 1`, no skill requirement) deliberately measures
   orchestration overhead, not CP-SAT's worst case on a hard model.** A
   future load test targeting "many hard, skill-constrained shifts per
   site at scale" would measure a different (and likely more solver-time-
   dominated) bottleneck — not run here, and not claimed to be covered by
   this one.

## Out of scope for this phase (do not build yet)

- True cross-worker parallel execution of one job's decomposed groups — a
  documented future enhancement, not started.
- A real commercial-solver (Gurobi/CPLEX) integration — the trigger point
  exists and is precisely defined; there is no license in this environment
  to wire it to.
- Fixing `_materialize_groups`'s `O(sites × employees)` group-materialization
  pass — a real, measured, honestly-flagged characteristic at 100k/500-site
  scale (~7.7s of the ~17s total wall time), not yet a proven bottleneck
  worth the complexity of an index-based rewrite at any scale this module
  has actually been asked to handle.
- `pg_partman`/automated partition rotation for `shift_assignments` — a
  real, reachable gap the load test's own first run hit directly (a
  far-future date fails closed with a raw Postgres `CheckViolationError`),
  documented in the runbook, explicitly out of scope per ADR-0053.
