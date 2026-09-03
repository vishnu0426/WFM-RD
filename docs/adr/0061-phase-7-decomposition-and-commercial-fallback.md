# ADR-0061: Phase 7 decomposition strategy and the commercial-solver-fallback trigger

## Context
§7.1 requires three things, precisely: (1) a defined strategy for splitting
a large org unit into parallel-solvable sub-problems, including how
genuinely-coupled sub-problems (a rare skill shared across sites) are
handled — "either a lightweight coordination pass... or keeping genuinely
coupled sites in one sub-problem"; (2) a real load test at 100k+ employee
scale with recorded results; (3) "a specific, measurable trigger condition"
for falling back to a budgeted commercial solver — not "use Gurobi if it's
too slow" left unspecified.

## Decision 1: decompose by each shift's own `org_unit_id`, not the job's top-level scope
`ScheduleJob.org_unit_id` names one (potentially large, e.g. a whole
region) org unit; the *shifts and employees within it* belong to individual
sites lower in Module 02's org-unit tree. `Employee`/`ShiftSlot` (solver
types) both gain an `org_unit_id: uuid.UUID | None` field (`SchedulableEmployee`
already carries this over gRPC, per Phase 6's `employee.proto` — it was
simply never stored; request-supplied `ShiftSlotInput` gains the field as a
new optional input). `app/solver/decomposition.py::decompose(solve_input)`
groups shifts by `org_unit_id` — each distinct value is a candidate
independent sub-problem, seeded with the shifts at that site and the
employees whose own `org_unit_id` matches it ("home employees").

**Below a threshold, decomposition is a deliberate no-op.**
`DECOMPOSITION_EMPLOYEE_THRESHOLD` (200) — a `SolveInput` at or under this
size returns `[solve_input]` unchanged: single group, `decomposition_plan`
records `{"decomposed": false, "reason": "below threshold"}`. This is not a
performance shortcut alone — it's what keeps every pre-Phase-7 test's
behavior byte-for-byte identical (every one of them submits well under 200
employees), and it's the honest floor: decomposition trades solve-time
tractability for solution *optimality* (site-independent solves can't
trade fairness/preference satisfaction across sites the way one monolithic
model could), so it should only ever engage where it's actually needed.

## Decision 2: coupling is detected per-skill and resolved by merging sites — never by a coordination pass
For each `required_skill_id` appearing in shifts at two or more distinct
sites, compare each site's own **home-employee pool qualified for that
skill** against that site's own total headcount requirement for shifts
needing it. If any site's local qualified pool can't cover its own
requirement, every site sharing that skill requirement is merged into one
sub-problem (union-find over site groups) — the "keeping genuinely coupled
sites in one sub-problem" option, chosen explicitly over "a lightweight
coordination pass after independent site-level solves." A coordination pass
(solve each site independently first, then patch shortfalls with a second
pass reassigning across sites) is a real, more complex alternative that
was considered and rejected for this phase: it needs a second solve
formulation (the "patch" step is its own constraint problem, not just
picking leftover capacity), and correctly modeling "site A's shortfall can
only be filled by site B's *already-committed-elsewhere* employees" without
re-litigating site B's own solved assignments is a materially harder
problem than this phase's actual, immediate need (making a shared
rare-skill pool solvable *at all*, not solving it optimally). Merging is
conservative (a merged sub-problem is provably at least as capable as two
independent ones, since it's a superset of both their feasible regions) and
correct by construction, at the cost of a larger, slower sub-problem for
exactly the sites that need it — an accepted, explicit trade-off, not an
oversight.

Employees whose `org_unit_id` matches no site with any shifts in this job's
own scope are excluded from every sub-problem — consistent with today's
behavior, where `SolveInput.employees` is already exactly "the eligible
pool for this scope," not a superset the solver has to filter.

## Decision 3: sub-problems solve sequentially within one worker's claim, not distributed across workers
Each `SolveInput` group produced by `decompose()` is solved one after
another, inside the same `execute_job` call that claimed the parent
`ScheduleJob` (ADR-0060). A real distributed-decomposition design — each
group becomes its own claimable unit, picked up independently by whichever
worker is free, with a coordinator merging results once all children finish
— was considered and explicitly deferred, not built this phase: it needs
child-job tracking, partial-failure/partial-completion semantics, and a
merge-and-finalize step distinct from "one row, one worker, one outcome"
(ADR-0060's own model). Sequential-within-one-claim already solves this
phase's actual, measured problem — **tractability**, not wall-clock
parallelism. CP-SAT's complexity is highly super-linear in problem size, so
200 sequential ~500-employee solves reliably completing is a fundamentally
different (solvable) problem than one 100,000-employee model (which the
load test below never even attempts to run monolithically, because it
would not finish in any reasonable time). True cross-worker parallel
sub-problem execution is flagged as a real, natural next step in the
readiness checklist, not silently assumed unnecessary.

**Merge semantics**: assignments from every group's `SolveResult` are
concatenated (globally unique UUIDs mean no reindexing is needed);
objective values and solve durations sum. **Any single group coming back
`infeasible` makes the whole job `infeasible`** — §5's relaxation search
(ADR-0057) runs per infeasible group independently, and
`ScheduleJob.relaxations_applied` gains a `perGroup` breakdown (which
site-group(s) failed, and what relaxing would cost *for that group
specifically*) rather than one flat payload assuming a single scope. A
human reviewing an infeasible decomposed job sees exactly which site(s) are
the problem, not an opaque "somewhere in 100,000 employees, something
doesn't fit."

## Decision 4: the commercial-solver-fallback trigger is precisely defined and precisely not wired to a real solver
**Trigger**: a sub-problem with more than `COMMERCIAL_FALLBACK_EMPLOYEE_THRESHOLD`
(300) employees whose `SolveResult.status == "unknown"` (CP-SAT exhausted
its time budget with neither a solution nor a proof of infeasibility - see
`SolveResult.status`'s own docstring for why this is never conflated with
`infeasible`). `app/solver/commercial_fallback.py::should_trigger_commercial_fallback`
is a pure, directly unit-tested function — the measurable condition §7.1
asks for, not a vague "if it's too slow."

**No real Gurobi/CPLEX license exists in this environment.** When the
trigger fires, the worker raises `CommercialFallbackRequiredError` and the
job resolves to `failed` with a structured reason naming the trigger
condition explicitly (`"CP-SAT exceeded its time budget on a N-employee
sub-problem; commercial solver fallback is not configured"`) — an honest,
diagnosable failure a human can act on (increase the CP-SAT time budget,
decompose further, or provision a real commercial license), never a silent
"it just didn't work" or a fabricated success. §1's own instruction —
"a budgeted Gurobi/CPLEX license... not a silent substitution" — is honored
by defining the trigger for real and refusing to fake the substitution,
not by skipping the trigger definition because the substitution isn't
available to build.

## Consequences
- `Employee`/`ShiftSlot` gaining `org_unit_id` is additive (`None` default)
  — every existing solver-level test, and every gRPC pull that doesn't
  bother setting it, is unaffected.
- `ScheduleJob.decomposition_plan` (a real jsonb column since Phase 1,
  unused until now) finally gets real data: group count, per-group
  employee/shift counts, which sites merged and why, per-group solve
  status/duration.
- The load test (Phase 7 readiness checklist) is this ADR's own proof: a
  100k-employee synthetic dataset that decomposes into ~200 independent
  ~500-employee sub-problems, each solving in seconds, the aggregate
  completing in a bounded total time recorded as a real artifact — not a
  monolithic 100k-employee CP-SAT model, which was never attempted (and
  would not have finished).
