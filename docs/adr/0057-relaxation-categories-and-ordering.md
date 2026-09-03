# ADR-0057: Which hard constraints are relaxable, and in what order

## Context
§5 requires that on `INFEASIBLE`, the solver "re-run with hard constraints
relaxed one category at a time... define the relaxation order explicitly...
a sensible default is cost-impact-ascending." The module prompt gives
exactly one worked example — relaxing the overtime cap first — and is
silent on which of §3.1's other hard constraints are relaxation candidates
at all. This module's own §0 non-negotiable ("a hard constraint is never
allowed to become a weighted objective term for simplicity") and its
"legal-liability bug, not a UX bug" framing mean this can't be answered by
just relaxing everything in some order — some of §3.1's constraints protect
things a scheduling system has no authority to trade away at all, no matter
how a human clicks "approve."

## Decision
Four constraints are relaxable, in this cost-ascending order:

1. **`contracted_hours`** — the module prompt's own example. Removes the
   hard weekly-hours cap for employees who weren't pre-approved for
   overtime. Cheapest to relax: it's a business-process gate (someone needs
   to approve overtime), not a legal or safety limit in itself — the
   underlying labor-law maximum-hours question, if this platform ever adds
   one (§3.1's own note that no absolute cap exists yet, ADR unchanged),
   would sit above this in the ordering, not be conflated with it.
2. **`shift_length_bounds`** — the union-rule minimum/maximum shift length
   check (`_validate_shifts`). Real union contracts commonly have negotiated
   exception processes for shift-length deviations; costlier than overtime
   approval but still a process/contractual matter, not a safety absolute.
3. **`min_rest_between_shifts`** — the labor-law minimum-rest-between-shifts
   constraint. Costlier still: several real jurisdictions' working-time
   regulations (e.g. the EU Working Time Directive's compensatory-rest
   provisions) do have a defined exception mechanism for reduced rest, which
   is why this is relaxable at all rather than absolute — but it is placed
   above shift-length because reduced rest has a more direct fatigue/safety
   consequence than a shift being a few minutes outside its normal bounds.
4. **`max_consecutive_working_days`** — the labor-law maximum-consecutive-
   working-days constraint. Highest relaxable cost: fatigue accumulates
   with consecutive days worked in a way a single night's rest doesn't fix,
   so this is placed last — a relaxation search should only reach for it
   once the three above have already proven insufficient.

**Never relaxable, under any human approval, by this flow:**

- **Skill requirement** — assigning an employee without a current,
  non-expired certification to a skill-required shift is not a schedule
  trade-off; it is the platform placing an unqualified person into a role a
  policy says they aren't qualified for. No "business cost" framing applies.
- **Leave/unavailability** — approved leave is the employee's own legal/
  consent boundary (or, once Module 06 exists, a formally approved absence
  record); a scheduling system overriding it is not a scheduling decision,
  it's overriding someone else's approval.
- **No-double-booking / shift-overlap prevention** (the overlap half of
  `_add_no_conflict_constraints`) — a physical impossibility, not a policy
  choice. Only the *minimum-rest* half of that check is relaxable (category
  3); overlap prevention stays absolute regardless.
- **Mandatory break placement** (the break-length half of `_validate_shifts`,
  distinct from the shift-length-bounds half that *is* relaxable) — tied
  directly to fatigue/safety in the same way overlap prevention is tied to
  physical possibility.

`ScheduleJob.relaxations_applied`'s structured payload always lists which
categories were tried, and the explanation text generated from it is
explicit that skill/leave/double-booking/mandatory-break were never
candidates — so a Scheduler/Planner reading the result never has to wonder
whether those were silently considered and rejected versus never on the
table at all.

## A structural gap found while implementing this

`shift_length_bounds` is implemented correctly in `app/solver/model.py` (a
relaxed solve genuinely skips the min/max length check) and is exercised
directly by a unit test that calls `solve()` with it relaxed. But the
relaxation *search* (`app/solver/relaxation.py`) can never actually reach a
scenario where it matters, given this module's existing architecture:
`_validate_shifts` runs unconditionally, before any solve, and rejects an
out-of-bounds shift outright with `422 INVALID_SHIFT_DEFINITION`
(§3.1/Phase 2's own deliberate design) — so a job whose shifts violate the
length bounds never reaches `status: infeasible` in the first place; it
never gets submitted successfully at all. The relaxation search only ever
runs against jobs that already passed that upfront check, meaning every
`SolveInput` it ever sees already satisfies `shift_length_bounds`
unconditionally, and relaxing it changes nothing.

This is a real, honest gap between "the mechanism is implemented and
correct in isolation" and "it is reachable end-to-end" — not fixed in this
phase, because fixing it would mean undoing Phase 2's own deliberate choice
to reject malformed shift templates immediately rather than let the solver
discover the problem later as an opaque infeasibility. `shift_length_bounds`
stays in `RELAXATION_ORDER` for structural completeness (it is harmless to
include - relaxing a category that doesn't matter just doesn't change the
outcome, and the search continues to the next category regardless), and
this gap is called out explicitly in the Phase 4 design doc and production
readiness checklist rather than left for someone to discover by noticing the
category never appears in a real `relaxations_applied` payload.

## Consequences
- The relaxation search is a **monotonic, cumulative** widening, not an
  exhaustive combinatorial search: try category 1 alone; if still
  infeasible, try categories 1+2 together; then 1+2+3; then all four. This
  is a direct reading of §5's "one category at a time" phrasing as
  introducing categories one at a time into an accumulating relaxed set,
  and keeps the search to at most 4 additional solves (bounded, predictable
  cost) rather than the 2⁴ combinations a full power-set search would need.
  A future phase could revisit this if a real scenario shows the cumulative
  order misses a materially cheaper combination the power set would have
  found — not assumed impossible, just not built now.
- If all four relaxations are exhausted and the job is still infeasible,
  that is itself a reportable, structured outcome (`relaxations_applied`
  records the full attempt list and that no combination worked) — not a
  silent fallback to "just fail," and not a prompt to reach for the
  never-relaxable set as a last resort.
- This ordering and non-relaxable set is this module's own judgment call in
  the absence of a jurisdiction-specific labor-law engine (out of scope for
  this platform entirely) — it is a defensible default, not a claim that it
  is correct for every jurisdiction/union contract this platform might ever
  operate under. Flagged in the Phase 4 production readiness checklist as a
  policy decision a real deployment's legal/compliance function should
  review before go-live, not just accept because it shipped.
