# Module 04 Phase 3 Design Doc — Scheduling Engine: Soft Constraints + Fairness as a Bounded Constraint

**Status:** Approved for implementation
**Owner:** Scheduling pod (Module 04) — Principal Operations Research Engineer
+ Security/Compliance Architect sign-off on §3.3's fairness bound being a
real constraint, not an objective term
**Scope:** §3.2's soft constraints in full (employee preference, cost
minimization, skill decay, cross-skill balance) as CP-SAT objective terms;
§3.3's fairness bound as a genuine, tenant-configurable, hard CP-SAT
constraint spanning schedule runs; the `FairnessLedger` cross-run read model
(§3.3, §9's own Phase 3 scope) and its refresh trigger
(`POST /v1/scheduling/schedules/{scheduleId}/publish`); the compliance-
auditor query (`GET /v1/scheduling/fairness/audit`). No infeasibility-
relaxation flow (§5, Phase 4), no locked-assignment pre-solve partition
(Phase 5), no gRPC data pulls (Phase 6).

## Problem

Two requirements in this phase are easy to conflate and the module prompt is
explicit that they must not be: §3.2's soft constraints are genuinely
tradeable objective terms (a tenant can weight them however it wants, and
the solver is free to sacrifice one for another), but §3.3's fairness bound
is *not* — "not purely an objective term alone... this is not purely
optional/tradeable." Getting this distinction backwards — folding fairness
into the weighted sum alongside preference/cost/decay — would mean the
solver could always trade fairness away for a cheaper schedule, exactly the
outcome the module prompt calls out as unacceptable.

A second problem: §3.3's rolling-period window is explicit that fairness
"spans schedule runs, not just the current solve." Phase 2's solver has no
memory of anything outside one `solve()` call. Something has to durably
record what actually happened in previously *published* schedules and feed
it back into later solves — the `FairnessLedger` the module prompt names
directly.

## Decision

**§3.2 as objective terms** (`app/solver/model.py::_build_objective_terms`):
employee preference (reward matching `Employee.preferred_shift_ids`),
overtime cost (penalize minutes worked beyond a hard-capped employee's
weekly cap — only meaningful for `overtime_approved` employees, since
everyone else is already hard-capped at zero overtime), skill decay
(penalize assigning a more-decayed `EmployeeSkill.decay_score` to a skill-
required shift), cross-skill balance (reward spreading a required skill
across more distinct employees rather than concentrating it). All four are
independently switched off by a zero weight, and all default to a modest
positive weight (`SoftWeights`'s Pydantic defaults) so a tenant that submits
no explicit weights still gets sensible behavior rather than silently
getting none of §3.2 unless it opts in.

A fifth, unnamed-but-necessary term was added during this phase: coverage-
excess minimization. Phase 2's own coverage constraint is `>=`, not `==`
(overstaffing isn't a labor-law violation), but with *zero* pressure against
it, CP-SAT would happily pad a shift with redundant staff at no cost — found
by the objective's own test suite assigning a third, unneeded person to a
2-person shift on the very first cross-constraint scenario tried. Folded
into the `overtime_cost_weight` term (documented as covering "cost
minimization" broadly, not just overtime specifically) rather than adding a
sixth independent weight — see `_build_objective_terms`'s inline comment for
the reasoning.

**§3.3 as a real constraint** (`_add_fairness_constraint`): for each roster
employee `e`, `historical_count[e] + this_solve's_assigned_undesirable[e]`
is bounded to within `tolerance` of the roster's own average — expressed as
`count[e] * n` vs. the group's summed total (`n` = roster size) to avoid
division, which CP-SAT's integer linear constraints don't support directly.
`"undesirable"` is tenant-configurable (`FairnessConfigInput`: weekend
inclusion, a configurable night window, explicit holiday dates) — never a
platform-fixed definition, per §3.3's own instruction.

**`FairnessLedger`** (migration 0002): one row per `ShiftAssignment`,
written once, at **publish** time (`schedule_service.publish_schedule`), not
solve time — a solve that never gets published never contributes to anyone's
fairness history. `is_undesirable` is computed and frozen using the
*publishing job's own* `constraint_config.fairness` (or the platform default
if it set none) at that moment, so a later change to the platform's
undesirable-shift rules can never retroactively change what an already-
published ledger entry says — the audit trail stays honest by construction.
Partitioned `RANGE` monthly on `shift_start`, same reasoning as
`shift_assignments` (ADR-0053) — this table has the identical unbounded-by-
employee-count growth profile.

**`constraint_config` gets a concrete shape** (`ConstraintConfigInput`),
fulfilling the promise Phase 1's own design doc made ("not validated against
a concrete shape yet — that's Phase 3's fairness-as-a-bounded-constraint
work"): `{ fairness: FairnessConfigInput | null, softWeights: SoftWeightsInput }`.
`fairness: null` (the default) means §3.3's bound is not enforced for that
solve, matching Phase 2's "opt-in, not opt-out" posture for `policy`/
`shiftSlots`.

**The compliance-auditor query** (`GET /v1/scheduling/fairness/audit`) is
the module prompt's own literal bar: "show me the fairness tolerance policy
in effect for period X and prove no employee exceeded it," built as a real,
answerable API call, not a documentation claim. `tolerance` is a caller-
supplied query parameter (the auditor's own question — "would this have
violated tolerance N," which may differ from whatever tolerance any
individual `ScheduleJob` actually configured at solve time), not
auto-derived from historical `constraint_config` rows; the full audit trail
for "what policy actually applied when" remains reconstructable by joining a
`FairnessLedger` row back to its `schedule_id` → `ScheduleJob.constraint_config`,
without needing a separate policy-version-history table.

## Real bugs found and fixed during this phase

Verifying end to end against real Postgres (not assumed correct from code
review) surfaced five distinct, genuine issues — each fixed and documented
rather than quietly patched:

1. **The coverage-excess objective gap** described above.
2. **`ck_schedules_published_fields`'s `published_by IS NOT NULL`
   requirement** (written in Phase 1, never exercised until this phase built
   the first real publish path) was simply wrong: this platform has no real
   JWT validation anywhere yet (ADR-0014), so `published_by` is legitimately
   null today, exactly like `ScheduleJob.requested_by` already is elsewhere.
   Relaxed to require only `published_at`.
3. **A genuine SQLAlchemy `insertmanyvalues`/`RETURNING` sentinel-matching
   failure** for both `FairnessLedger` and (it turned out, a *latent* Phase 2
   bug) `ShiftAssignment` — see ADR-0056 for the full investigation and the
   raw-`text()`-insert fix.
4. **A naive-datetime timezone bug in test fixtures** (not application code):
   integration-test shift-time strings without an explicit UTC suffix were
   silently reinterpreted relative to the sandbox's local timezone on their
   round-trip through a `timestamptz` column, shifting the wall-clock hour
   a fairness assertion depended on. Fixed in both `test_fairness_ledger_api.py`
   and (defensively, for the same latent risk) `test_jobs_solve_api.py`.
5. **The `fairness/audit` endpoint's query parameters defaulted to
   snake_case** (`period_start`) instead of the platform's camelCase
   convention (`periodStart`) — FastAPI's default query-param naming follows
   the Python parameter name unless given an explicit `Query(alias=...)`,
   unlike this codebase's `CamelModel` bodies, which apply camelCase
   automatically. Fixed with explicit aliases.

## Blast radius

- New `fairness_ledger` table (migration 0002) and its RLS/grants — purely
  additive, no change to any existing table's schema.
- One DDL correction to `schedules.ck_schedules_published_fields`, applied
  by editing migration 0001 directly (this module has not been released
  beyond local/shared dev instances in this development cycle — no external
  consumer depends on the exact historical migration file yet, so this is a
  direct fix, not a follow-up migration).
- `ScheduleJobRequest.constraint_config` changes from an unvalidated
  `dict[str, Any]` to a validated `ConstraintConfigInput` — a real, intended
  contract evolution (Phase 1's own design doc committed to this), not an
  accidental break. Existing Phase 1/2 tests that sent arbitrary
  `constraintConfig` keys were updated to the new validated shape.
- `job_service.create_job`'s `ShiftAssignment` persistence changed from ORM
  `add()` to raw `text()` INSERT (ADR-0056) — same rows, same columns,
  different statement path; every existing Phase 1/2 test still passes
  unmodified against this change.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Fairness's rolling window looks backward from `date_range_start`,
   exclusive.** `[date_range_start - rolling_period_weeks*7 days,
   date_range_start)` — deliberately excludes the current job's own date
   range, so a job's own (not-yet-published) shifts are never double-counted
   against themselves.
2. **The fairness bound balances against the roster's own average, not an
   externally configured target.** The module prompt's "target_average ±
   tolerance" phrasing was read as "the team's own average" rather than a
   separately tenant-configured number — a fixed external target would need
   its own justification (why *that* number) that nothing in the source
   material supplies, whereas "no one drifts far from their peers" is
   fairness's actual, literal meaning.
3. **`is_overtime` attribution stays per-calendar-week** (unchanged from
   Phase 2) even though the objective now actively trades overtime against
   other soft terms — the attribution rule didn't need to change, only
   whether the solver is incentivized to avoid triggering it.
4. **Cross-skill balance's "distinct employees touching a skill" proxy**, not
   a stronger measure like "the *maximum* number of shifts any one employee
   holds for that skill" — the simpler reified-OR formulation composes
   cleanly with the rest of the linear objective; a min-max formulation would
   need its own auxiliary variables and was judged not worth the complexity
   for what the module prompt scopes as a soft, best-effort term.

## Out of scope for this phase (do not build yet)

- Infeasibility relaxation ordering, structured explanation payload, human-
  approval gate (§5) — Phase 4. This phase's fairness-driven infeasibilities
  (proven real and deterministic in the cross-run integration test) are
  reported correctly but nothing relaxes them yet.
- The locked-assignment pre-solve partition that would let a re-optimization
  respect Phase 1's `locked` generated column — Phase 5.
- `SchedulingDataProvider` gRPC, the Module 10 explanation handoff — Phase 6.
- Any GraphQL surface — `publishSchedule`'s real GraphQL mutation is still
  Node/Module 01's to build, fed by this phase's REST endpoint and events;
  not built here.
- Scale/performance validation of the fairness constraint's pairwise/summed
  formulation, or of `FairnessLedger` query performance at real employee
  counts — Phase 7.
