# Module 04 Phase 2 Design Doc — Scheduling Engine: Hard Constraint Model, Single-Site Scope

**Status:** Approved for implementation
**Owner:** Scheduling pod (Module 04) — Principal Operations Research Engineer
(CP-SAT modeling is this phase's actual content) + Security/Compliance
Architect sign-off on §3.1's legal-liability constraints being encoded as
hard, not soft
**Scope:** §3.1's full hard-constraint table (labor law compliance, contracted
hours, skill requirement, leave/unavailability, union rules), encoded
directly in Google OR-Tools CP-SAT for a bounded, non-decomposed ("single-
site") scope, plus §8's constraint-correctness test suite. Wired into
`POST /v1/scheduling/jobs` so a job with a complete solve-input payload
actually solves, synchronously, to a real terminal state. No soft constraints
(§3.2), no fairness bound (§3.3), no infeasibility-relaxation flow (§5), no
manual-override/locked-assignment re-optimization (§2.2 rule 1's *pre-solve
partition*, though the schema support for it — the `locked` generated
column — shipped in Phase 1), no gRPC data pulls (§4.3, still Phase 6 —
see ADR-0055), no decomposition (§7.1).

## Problem

This is the module's actual IP and its actual legal-liability surface (module
prompt §0). The non-negotiable stated at the top of the module prompt applies
directly to this phase: "a hard constraint is never allowed to become a
weighted objective term 'for simplicity.'" Phase 2's job is to encode every
constraint in §3.1's table so CP-SAT is *structurally incapable* of returning
a solution that violates one — and then to prove it, not assert it, via a
synthetic test suite with known-correct expected outcomes per constraint
(§8).

A second, narrower problem this phase has to resolve before writing any
CP-SAT code at all: §3.1's own prose talks about pulling policy/employee data
via gRPC "at solve time," but the module prompt's own §9 build-phase list
schedules that gRPC pull as **Phase 6** — after fairness, infeasibility
handling, and manual overrides. A CP-SAT model cannot be "provably correct"
against nothing; something has to supply real typed data for the correctness
suite to run against now. See ADR-0055 for the resolution: a pure,
DB/network-independent solver engine, fed by request-supplied data in this
phase, swapped for the real gRPC pull in Phase 6 without touching the
constraint logic itself.

## Decision

`app/solver/` is a new package, importable with zero dependency on
SQLAlchemy, FastAPI, or any network client — `types.py` declares frozen
dataclasses (`Employee`, `EmploymentPolicy`, `ShiftSlot`, `LeaveRecord`,
`SolveInput`, `Assignment`, `SolveResult`); `model.py`'s `solve(SolveInput)
-> SolveResult` builds and solves one CP-SAT model. This is what makes §8's
test suite possible without a database or a live Module 01/02 dependency:
`tests/unit/test_solver_constraints.py` has one synthetic scenario per hard
constraint, each solved for real (no mocked solver), asserting the correct
feasible/infeasible outcome.

§3.1's table maps onto the model as follows:

| §3.1 constraint | Encoding |
|---|---|
| Skill requirement | Eligibility gating — an employee without a current (non-expired) matching skill gets **no decision variable** for that shift at all. Structurally cannot be assigned, not merely discouraged. |
| Leave/unavailability | Same eligibility gating (ADR-0055's interim data source — carried in the request, per the module prompt's own explicit instruction for this constraint specifically). |
| Labor law: minimum rest between shifts | A single pairwise "conflict" check (`_conflicts`) that also catches literal time-overlap — one mechanism covers both the labor-law rest requirement and prevents `ScheduleConflict.double_booking` by construction, since both reduce to "the gap between two candidate shifts (negative if overlapping) is less than the required rest." |
| Labor law: maximum consecutive working days | A rolling-window sum constraint over boolean "worked that day" indicators, one window per `(max_consecutive_days + 1)`-day span in the schedule's date range. |
| Contracted hours | A hard per-**calendar-week** cap (Monday-start), skipped entirely for `overtime_approved` employees. Explicitly *not* prorated by the solve's date-range span — see "a real bug found and fixed" below. |
| Union rules: min/max shift length, mandatory break | Pre-solve **shift-template validation** (`_validate_shifts`), not a CP-SAT decision variable — *where* within a shift a break falls is floor-level scheduling this module doesn't do; what this module enforces is that a shift offered to the solver already satisfies the policy's length/break bounds. A shift that fails this is rejected outright (`ShiftViolatesUnionRulesError` → `422 INVALID_SHIFT_DEFINITION`), before any employee is even considered for it. |

**Coverage** (`sum(assigned) >= required_headcount` per shift) is added as a
structural precondition even though §3.1's table doesn't name it as its own
row — without it, "assign no one to anything" trivially satisfies every
other hard constraint. `>=`, not `==`: overstaffing isn't a labor-law or
contract violation, so it isn't rejected here; discouraging it is Phase 3's
job once an objective function (cost minimization) exists at all.

**Wiring into job submission** (`job_service.create_job`): a submission that
supplies both `policy` and `shiftSlots` is solved synchronously.
`optimal`/`feasible` → `ScheduleJob.status: completed`, a real `Schedule`
(`draft`) and its `ShiftAssignment` rows are persisted. `infeasible` (CP-SAT
*proved* no solution exists) → `status: infeasible`, no schedule row —
§2.2 rule 2's "first-class, expected outcome" honored from this phase
onward, not deferred to Phase 4. `unknown` (the solver's time budget expired
with neither a solution nor a proof of infeasibility) → `status: failed` —
deliberately not folded into `infeasible`; see `SolveResult.status`'s
docstring and ADR-0055.

## A real bug found and fixed during this phase

The first version of the contracted-hours constraint prorated
`contract_hours_per_week` by `(days_in_solve_scope / 7)`. This is
mathematically tidy and operationally wrong: for the single-day test
scenarios this phase's own correctness suite uses, it made one ordinary
8-hour shift read as exceeding a 40-hour/week contract, because a 1-day
scope prorates the weekly cap down to about 5.7 hours. Caught immediately by
running the constraint-correctness suite (5 of 17 tests failed with
`infeasible` where `feasible` was expected) — exactly what that suite exists
to catch, on the very first real run. Fixed by bucketing assigned hours per
Monday-start calendar week instead of prorating by the scope's span (see
`_add_contracted_hours_constraints`'s docstring and its `_week_start`
helper). A second real bug, found the same way one layer up (the full HTTP
integration suite): `ShiftAssignment.locked`'s SQLAlchemy mapping used a
plain `Mapped[bool]` with a Python-side default, which made the ORM include
it in every `INSERT` — Postgres's `GENERATED ALWAYS` column categorically
rejects that, `asyncpg.exceptions.GeneratedAlwaysError`, working exactly as
ADR-0054 intended, just against the ORM's own incorrect description of the
schema, not the schema itself. Fixed via SQLAlchemy's `Computed(...)`
construct (ADR-0054, updated). Both are recorded here and in the readiness
checklist rather than quietly fixed and left undocumented — the module
prompt's own §0.5 discipline about honest capacity claims applies equally to
"we tested this and it was wrong until X."

## Blast radius

- Purely additive to Phase 1: a new `app/solver/` package, extended
  `ScheduleJobRequest`/`ScheduleJobDetail` schemas (new fields are all
  optional — a Phase 1-shaped request, with no `policy`/`shiftSlots`, behaves
  exactly as it did in Phase 1), a new `GET
  /v1/scheduling/jobs/{jobId}/schedule` endpoint, one corrected column
  mapping in `app/db/models.py` (no migration change — the DDL was already
  correct; only the ORM's description of it was wrong).
- No schema/migration changes at all in this phase.
- Every Phase 1 integration test still passes unmodified (verified against
  the same real shared Postgres + local NATS this module's Phase 1 was
  verified against).

## Explicit assumptions (spec was ambiguous or silent here)

1. **Solve-input data arrives via the request body, not gRPC.** ADR-0055,
   covered in full there. The request contract is explicitly a Phase 2
   scaffold; Phase 6 is expected to slim it back down once the solver can
   source `roster`/`policy`/`shiftSlots`/`leaveRecords` itself.
2. **Solving is synchronous, inside the HTTP request.** Also ADR-0055. A
   real, stated gap against §0.5's own p95 < 3 minute SLO for single-site
   solves — acceptable only because there is no worker-pool infrastructure
   to solve against asynchronously yet, and because this phase's actual
   (small, synthetic) scope solves in milliseconds. `time_limit_seconds`
   (default 30s) bounds the worst case.
3. **Contracted-hours cap is per Monday-start calendar week, not prorated by
   the solve's date range.** See "a real bug found and fixed" above.
4. **Union-rule shift-template checks are pre-solve validation, not CP-SAT
   constraints.** A shift that violates them was never a valid input to
   offer — rejecting it before model-building keeps the CP-SAT model itself
   focused on genuine assignment decisions, and gives a clean `422` instead
   of an opaque infeasibility whose root cause would otherwise be buried
   inside the solver's output.
5. **No absolute (non-contract-relative) maximum-hours cap exists yet.** The
   module prompt names contracted-hours-vs-overtime-approval as the only
   hours-related hard constraint in §3.1; an `overtime_approved` employee has
   no upper bound in this phase's model at all. If a future phase needs a
   hard legal ceiling independent of contract/approval status, it composes
   the same way `_add_contracted_hours_constraints` does.
6. **`is_overtime` is attributed per calendar week, not per specific shift.**
   §3.1's flag is about *permission* to exceed contract hours; which
   specific shift among several "is" the overtime one for a given week isn't
   a decision this phase's model makes (there's no unique correct answer
   without further business rules) — every assignment in a week where the
   employee's total exceeds their cap is marked `is_overtime: true`.

## Out of scope for this phase (do not build yet)

- Soft constraints, cost minimization, cross-skill balance objective terms —
  Phase 3 (§3.2).
- Fairness as a bounded constraint, `FairnessLedger` — Phase 3 (§3.3).
- Infeasibility relaxation ordering, structured explanation payload, human-
  approval gate — Phase 4 (§5). This phase's `infeasible`/`failed` statuses
  are real and correctly distinguished, but nothing yet *does* anything with
  an infeasible result beyond reporting it.
- The pre-solve fixed/solvable partition step that reads `locked` — Phase 5.
  The column and its correctness guarantee (ADR-0054) already exist; nothing
  reads it yet because nothing re-optimizes an existing schedule yet.
- `SchedulingDataProvider` gRPC, the Module 10 explanation handoff —
  Phase 6.
- Decomposition, the 100k+ employee load test, commercial-solver fallback —
  Phase 7. This phase's pairwise conflict-constraint construction is
  `O(employees × shifts²)` per employee, which the module prompt's own
  100k+-employee framing makes clear will not scale past single-site,
  bounded scope without decomposition — flagged, not silently assumed fine.
- Zero-downtime deploy support — Phase 8.
