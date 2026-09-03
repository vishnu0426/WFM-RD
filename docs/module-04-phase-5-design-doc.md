# Module 04 Phase 5 Design Doc — Scheduling Engine: Manual Override / Locked-Assignment Re-optimization

**Status:** Approved for implementation
**Owner:** Scheduling pod (Module 04)
**Scope:** §2.2 rule 1 in full — the pre-solve partition into fixed vs.
solvable variables (ADR-0058), plus the write paths that make it reachable:
`overrideAssignment`'s REST equivalent, and re-optimization. No gRPC data
pulls (Phase 6), no decomposition (Phase 7), no schedule-versioning
lifecycle management (explicit assumption below).

## Problem

§2.2 rule 1 is one of this module's non-negotiables: any `ShiftAssignment`
with `assignment_source != auto_generated` must be forced as a fixed
variable on every subsequent re-optimization, never silently re-solved away.
Phase 1 already made this structurally true at the schema level
(`ShiftAssignment.locked`, a `GENERATED ALWAYS` column — ADR-0054), but
nothing before this phase actually *wrote* a non-`auto_generated`
`assignment_source`, or *read* `locked=true` back into a solve. Three things
were missing: a way for a human to make a manual override in the first
place, a way for the solver to force it on re-optimization without that
forcing making the whole model infeasible, and a way for the schedule's
other assignments to still get freely re-solved around it.

The middle piece is the hard one, and it's where ADR-0058 does the real
work: a locked assignment is a *given fact*, not a decision the solver's own
hard constraints get to veto. A manual override that happens to exceed a
contracted-hours cap, or two overrides that happen to conflict with each
other, are real possibilities a human is allowed to create — the solver's
job on re-optimization is to work around them, not refuse to run at all.

## Decision

**`POST /v1/scheduling/schedules/{scheduleId}/assignments/{assignmentId}/override`**
(`schedule_service.override_assignment`) reassigns an existing
`ShiftAssignment` to a new employee and sets `assignment_source:
manual_override` — `locked` follows automatically from the generated
column. Every §3.1 eligibility check (skill match, leave, contracted hours)
is deliberately bypassed: a human override is trusted, not re-validated,
the same reasoning ADR-0058 uses for the solver side. The one check that
does run is `double_booking` — Phase 5's conflict-detection scope, checked
against this employee's *other* assignments already persisted on the same
schedule (real data this service already has, no policy/skill data needed).
A detected conflict doesn't block the override; it writes an open
`ScheduleConflict` row so it's visible, not silently absorbed. `GET
/v1/scheduling/schedules/{scheduleId}/conflicts` reads them back — added in
this phase specifically so a written conflict is actually reachable over
HTTP, not a table only this phase's own code ever touches.

**`SolveInput.locked_assignments: tuple[LockedAssignment, ...]`**
(`app/solver/types.py`) carries the pre-solve fixed/solvable partition into
the model. `LockedAssignment` also carries `assignment_source` — not for
solver logic (`app/solver/model.py` never reads it), but so
`_persist_schedule` can restore the real `assignment_source`
(`manual_override`/`swap`/`bid`) when a locked pair gets re-persisted,
instead of defaulting every assignment to `auto_generated` and silently
erasing that it was a human decision. `solve()` creates a decision variable
for every locked pair *unconditionally* (bypassing `_is_eligible`) and
forces it to `1`. Four hard constraints needed a matching adjustment so a
locked fact can never make the model infeasible on its own — the full
per-constraint breakdown (effective-cap/window pattern, locked-locked
conflict skip) is ADR-0058's, not repeated here.

**`POST /v1/scheduling/schedules/{scheduleId}/reoptimize`**
(`job_service.reoptimize_schedule`) is a new solve with its own
`ScheduleJob`, behaving exactly like `POST /v1/scheduling/jobs` otherwise
(same `Idempotency-Key` replay semantics, same completed/infeasible/failed
terminal states, same relaxation-search-on-infeasible). What's specific to
it: every currently-locked `ShiftAssignment` on the schedule is matched into
the request's own `shiftSlots` by `(start, end, requiredSkillId)` — **not**
by id. The original request-supplied `ShiftSlot.id` (ADR-0055) was never
persisted (`ShiftAssignment` has no `shift_id` column), so a shift's own
time/skill definition is the only stable identity available across
requests; the caller resupplies full shift/roster/policy data, the same
shape it already has from having called `GET .../schedule` to decide what
to override in the first place. A locked shift missing from the resupplied
`shiftSlots`, or a locked employee missing from the resupplied `roster`, are
real caller errors (`422 LOCKED_SHIFT_MISSING_FROM_REQUEST` /
`422 LOCKED_ASSIGNMENT_EMPLOYEE_MISSING`) — the locked fact silently
vanishing from the problem would violate §2.2 rule 1, so this is rejected
outright rather than guessed at.

**A correctness fix in `approve_relaxation`, found while wiring this up:**
it previously rebuilt its re-solve `SolveInput` as a manually-enumerated
field-by-field literal. That silently drops any field added to `SolveInput`
after that code was written — which is exactly what would have happened to
this phase's own `locked_assignments`: a *reoptimize* job that goes
infeasible, records a relaxation option, and later has it approved would
have re-solved with its locked assignments silently un-forced. Fixed by
switching to `dataclasses.replace(original_input, relaxed_categories=...)`,
which only touches the field being changed and carries everything else
(present and future) forward untouched. `solve_input_serde.py` was extended
to round-trip `locked_assignments` (including each one's `assignment_source`)
through `ScheduleJob.solve_input_snapshot` for the same reason.

## A real bug found while writing this phase's own integration tests

`schedule_service.override_assignment` originally returned the mutated
`ShiftAssignment` ORM instance directly after `await session.flush()`. The
API layer's response construction then touched `.locked` — but `locked` is
`GENERATED ALWAYS` (ADR-0054), so `flush()` expires that attribute on the
instance (the DB, not this process, just recomputed it). A bare post-flush
attribute access tries to lazy-load it, which requires an awaited DB
round-trip SQLAlchemy's async ORM can't do from a synchronous attribute
getter — `sqlalchemy.exc.MissingGreenlet`, caught immediately by the first
integration test that actually read the response body. Fixed with an
explicit `await session.refresh(assignment)` before returning, inside the
service function rather than pushed onto every caller.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Re-optimizing does not auto-archive the source schedule.** `Schedule.
   status` includes `archived` (§2.1), but nothing in §2.2 rule 1 or §5's
   walkthrough scenario says what should happen to the *schedule being
   reoptimized from*. Auto-archiving it would mean this phase silently
   inventing schedule-versioning lifecycle rules (who can un-archive, does
   publishing the new one auto-archive the old one, what happens to the old
   one's own `FairnessLedger` rows already written if it was published) that
   the spec never asked for. Reoptimize instead always produces a brand-new
   `Schedule` under a brand-new `ScheduleJob`; the source schedule is left
   exactly as it was. A real deployment likely wants an explicit
   archive/supersede flow — flagged here as a real gap, not silently
   decided by omission.
2. **Reoptimize is blocked on `archived` schedules, allowed on both `draft`
   and `published` ones** (`ScheduleArchivedError`, 409). Nothing in the
   spec restricts re-optimization to pre-publish schedules — "an employee
   calls in sick after publish, a manager overrides and reoptimizes the
   rest" is a real scenario this reading supports; only a genuinely closed
   historical record (`archived`) refuses further mutation.
3. **`override_assignment` can retarget any existing assignment to any
   employee id, with no roster/eligibility validation against that
   employee at all** — not even "does this employee id look like a real
   UUID that exists somewhere." This is deliberate (ADR-0058 point 4's
   reasoning applied at override time instead of solve time): the module
   this service would ask ("does employee X exist and are they
   schedulable") is Module 02, reachable only via the Phase 6 gRPC pull
   that doesn't exist yet, and this service has no local employee data to
   validate against per ADR-0055. Validating an override against a roster
   the override endpoint doesn't itself receive would mean inventing a
   second, parallel data-supply contract just for this one endpoint,
   inconsistent with how the rest of this module sources that data.
4. **`double_booking` is the only conflict type this phase detects**,
   exactly as ADR-0058 already scoped: it's the only one derivable from data
   this service persists itself (two assignments' own `shift_start`/
   `shift_end`). `skill_gap`/`leave_overlap`/`overtime_breach` need
   employee skill/leave/contract-hours data this service doesn't store —
   Phase 6's real gRPC pull, not invented early as a one-off.
5. **Reoptimize requires `policy` and `shiftSlots`; there is no "parked at
   queued" behavior for it.** Unlike `POST /v1/scheduling/jobs` (ADR-0055's
   "all optional" posture — a submission can be parked with nothing solved
   yet), a reoptimize call only exists because a schedule already needs
   re-solving; there's no meaningful "reoptimize with nothing to solve"
   state to park at.
6. **Locked-shift matching uses exact equality on `(start, end,
   requiredSkillId)`, with no fuzzy/nearest-match fallback.** A caller that
   resupplies a locked shift's time slightly shifted (even by a minute) hits
   `LOCKED_SHIFT_MISSING_FROM_REQUEST` rather than being silently
   "helpfully" matched to the wrong shift — a wrong silent match would be a
   far worse failure mode than a loud, correct rejection.

## Blast radius

- `SolveInput` gained one new field (`locked_assignments`, defaulting to
  `()`) and `LockedAssignment` gained `assignment_source` (defaulting to
  `"manual_override"`) — every existing call site keeps today's exact
  behavior unchanged.
- Three constraint-building functions in `app/solver/model.py`
  (`_add_no_conflict_constraints`, `_add_max_consecutive_days_constraints`,
  `_add_contracted_hours_constraints`) gained an optional `locked_pairs`
  parameter, defaulting to `frozenset()` — every existing test (92 before
  this phase's own additions) passed unmodified against this change.
- `job_service._persist_schedule` derives `assignment_source` per row from
  `solve_input.locked_assignments` instead of always writing
  `auto_generated` — a behavior change only observable when
  `locked_assignments` is non-empty, i.e. only on the new reoptimize path.
- Two new endpoints (`override`, `reoptimize`), one new read endpoint
  (`conflicts`), five new error codes — no changes to any existing
  endpoint's request/response contract.
- `job_service.create_job`'s idempotency-lookup logic was factored into
  `_find_existing_job_by_idempotency_key`, reused by `reoptimize_schedule` —
  behavior-preserving for `create_job` (same lookup, same order of
  operations), new for `reoptimize_schedule`.
- `app/api/v1/jobs.py`'s `_build_solve_input` was refactored to use a new
  shared `app/services/solve_input_conversion.py` module instead of
  building `Employee`/`ShiftSlot`/`EmploymentPolicy`/`LeaveRecord`/
  `SoftWeights`/`FairnessConfig` inline — extracted because the reoptimize
  endpoint needs the exact same Pydantic-to-solver-dataclass mapping and
  duplicating it verbatim across two files would mean two copies to keep in
  sync by hand indefinitely.

## Out of scope for this phase (do not build yet)

- `SchedulingDataProvider` gRPC data pulls, the Module 10 explanation
  handoff — Phase 6. Reoptimize still takes roster/shift/policy data via
  the request body (ADR-0055), same as every prior phase.
- Decomposition, the 100k+ employee load test — Phase 7.
- Zero-downtime deploys, graceful draining/reaper — Phase 8.
- `skill_gap`/`leave_overlap`/`overtime_breach` conflict detection — Phase 6
  (needs data this service doesn't persist yet).
- Any GraphQL surface (`overrideAssignment`, `resolveConflict`) — Node/
  Module 01's job, fed by this phase's REST endpoints and the new
  `ScheduleConflict` read model; not built here.
- Any schedule-versioning/archival lifecycle (auto-archiving a reoptimized-
  from schedule, explicit archive/supersede endpoints) — flagged as a real
  gap above, not scheduled to any specific future phase in this build
  sequence.
