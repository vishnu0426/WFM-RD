# ADR-0058: Locked assignments are fixed facts the solver works around, never inputs the solver's own hard constraints can reject

## Context
§2.2 rule 1 requires that any `ShiftAssignment` with `assignment_source !=
auto_generated` be passed to CP-SAT as a fixed/locked variable on every
re-optimization — "an explicit pre-solve step that partitions the
assignment set into 'fixed' and 'solvable' before the model is even built."
Forcing a decision variable to `1` (via `model.add(x == 1)`) is
straightforward. What isn't straightforward, and isn't addressed anywhere
in the module prompt, is what happens when a locked assignment — by
itself, or combined with another locked assignment — would violate one of
§3.1's own hard constraints if it were being freshly *decided* rather than
*given*:

- A manual override that alone pushes an employee over their contracted-hours
  cap (the override predates/ignores the cap the way a human overriding the
  system is allowed to).
- A manual override that alone pushes an employee's consecutive-working-days
  streak past the policy maximum.
- Two locked assignments (e.g., two separate manual overrides) that overlap
  in time or violate minimum rest against each other.

Naively forcing `x == 1` for locked pairs and leaving every constraint
otherwise unchanged means any of these situations makes the **entire CP-SAT
model** infeasible — not just "this one questionable override," but the
whole re-optimization, including every other employee and shift that has
nothing to do with the problem. That is clearly wrong: a human's already-made
decision shouldn't be able to block re-optimizing the rest of the schedule.

## Decision
**Locked assignments are treated as given facts the solver works around,
never as inputs the solver's own hard constraints can reject.** Concretely:

1. **Contracted hours** (`_add_contracted_hours_constraints`): the cap
   applied to a non-overtime-approved employee's *solvable* hours for a
   given week is `max(contract_cap, already_locked_minutes_that_week)`, not
   the raw contract cap. If locked assignments alone already exceed the
   cap, the effective cap becomes "no additional solvable hours this week,"
   not "infeasible."
2. **Maximum consecutive working days**
   (`_add_max_consecutive_days_constraints`): each rolling window's bound is
   `max(policy_max, already_locked_worked_days_in_that_window)` for the same
   reason — a locked streak that already exceeds the policy max caps
   *additional* solvable days at zero for that window, rather than blocking
   the model.
3. **Minimum rest / no-double-booking**
   (`_add_no_conflict_constraints`): the pairwise conflict constraint is
   skipped entirely when **both** shifts in a pair are locked for the same
   employee. Two locked assignments that already conflict are accepted as
   an existing fact (visible elsewhere as a `ScheduleConflict.double_booking`
   row, not modeled as a solver constraint); a locked-vs-solvable pair still
   gets the constraint normally (the solver simply won't pick the solvable
   side if it would conflict with the fixed one — this direction never
   causes infeasibility on its own).
4. **Skill requirement, leave/unavailability**: locked assignments bypass
   `_is_eligible` entirely — a locked `(employee, shift)` pair gets its
   decision variable created and forced to `1` unconditionally, regardless
   of whether that employee would normally be eligible for that shift. This
   is a deliberate consequence of §2.2 rule 1: a human's override already
   happened; the solver's job on re-optimization is to work around it, not
   to re-litigate whether it should have been allowed. (Whether it *should*
   have been allowed is a `ScheduleConflict` question, not a solver
   question — see below.)

**Coverage, the objective terms, and the fairness bound are unchanged** —
locked assignments' forced variables flow into these the same way any other
`x == 1` would, and none of them can be made infeasible by a locked
assignment alone the way a hard cap/window bound can (coverage is `>=`, the
objective has no feasibility failure mode, and fairness's own tolerance is a
tenant-configured knob, not a hard zero-slack bound — see the design doc's
explicit assumption about not special-casing fairness here).

## Conflict detection is scoped to what's actually derivable today
§2.1 names `ScheduleConflict.skill_gap`/`leave_overlap`/`overtime_breach` as
things a manual override could produce alongside `double_booking`. This
phase only detects **`double_booking`** — checked against the *other
assignments already persisted in the same schedule*, which is real data
this service already has. Detecting `skill_gap`/`leave_overlap`/
`overtime_breach` would require employee skill/leave/contract-hours data
this service has no persisted source for yet (ADR-0055: that data is
request-supplied per solve, not stored) — building a second, parallel
"supply employee data to the override endpoint" contract just for this
would be inconsistent with how every other part of this module sources that
data, and premature before Phase 6's real gRPC pull exists. Flagged
explicitly in the design doc and readiness checklist as a real, not
hypothetical, gap — not silently limited to `double_booking` without
comment.

## Consequences
- A `ScheduleJob` created by re-optimization can never fail *because of*
  what was already locked in — only because the *additional, solvable*
  portion has no feasible completion. This is the correct framing: a human's
  prior decision is a fact, not a proposal the solver gets to veto by
  refusing to run at all.
- This does **not** mean a locked assignment's own hard-constraint
  violations become invisible. They're still real, and still worth
  surfacing — that's what `ScheduleConflict` is for (this phase implements
  the `double_booking` case now; `skill_gap`/`leave_overlap`/
  `overtime_breach` await Phase 6's real data). A Scheduler/Planner reviewing
  open conflicts on a schedule sees them; the solver just doesn't refuse to
  work around them.
- The "effective cap/window" pattern (`max(policy_bound,
  already_locked_consumption)`) is a general technique this module will
  need again anywhere a future phase adds a new hard constraint with a hard
  numeric ceiling — noted here so it doesn't need to be rediscovered.
