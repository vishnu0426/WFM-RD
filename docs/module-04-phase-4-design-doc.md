# Module 04 Phase 4 Design Doc — Scheduling Engine: Infeasibility Handling

**Status:** Approved for implementation
**Owner:** Scheduling pod (Module 04) — Principal Operations Research
Engineer + Security/Compliance Architect sign-off on ADR-0057's relaxation
categories and non-relaxable set
**Scope:** §5 in full — relaxation search ordering (ADR-0057), the
structured explanation/cost-summary payload (§5 point 3), and the human-
approval gate (§5 point 4's non-negotiable). No locked-assignment pre-solve
partition (Phase 5), no gRPC data pulls (Phase 6), no decomposition
(Phase 7).

## Problem

§5 is explicit that an `infeasible` result isn't the end of the story, but
also explicit — at the same non-negotiable level as the hard constraints
themselves — that the system must never auto-apply a relaxation. Phase 2/3
already report `infeasible` correctly and distinctly from `failed`; what's
missing is everything downstream of that: deciding which hard constraints
are even legitimate to relax, in what order, computing what a relaxed
schedule would actually cost, and building a real approval mechanism a human
uses to turn "here's what would work" into an actual schedule — without ever
letting that happen automatically.

A second, harder problem surfaced while designing this: which of §3.1's
five hard-constraint categories are relaxation candidates at all? The module
prompt gives one example (the overtime cap) and no others. Getting this
wrong in either direction is a real risk — treating skill requirements or
approved leave as tradeable would turn this module's "legal-liability
surface" framing into an actual liability; treating labor-law rest/
consecutive-day limits as never-relaxable-under-any-circumstance would
ignore that several real jurisdictions' working-time regulations do have
defined exception mechanisms for exactly this. ADR-0057 resolves this with a
concrete, documented ordering and a concrete, documented non-relaxable set.

## Decision

**Relaxation is per-category and cumulative** (`app/solver/model.py`'s
`relaxed_categories` parameter, threaded through every relaxable
constraint-building function; `app/solver/relaxation.py`'s
`search_relaxations`). Four categories, cost-ascending: contracted hours,
shift length bounds, minimum rest between shifts, maximum consecutive
working days (ADR-0057). Never relaxable: skill requirement, leave/
unavailability, shift-overlap prevention, mandatory break placement.

**The search runs immediately, inline with the original solve**
(`job_service.create_job`): when the baseline `solve()` call returns
`infeasible`, `search_relaxations` runs before the response is returned,
trying relaxed category sets in the fixed order until one solves or all four
are exhausted. The result — which categories, whether feasible, a category-
specific structured cost summary, and a generated explanation sentence — is
recorded in `ScheduleJob.relaxations_applied`. `ScheduleJob.status` stays
`infeasible` regardless of what the search finds; nothing about running the
search changes the job's own terminal state, per §5 point 4.

**A snapshot of the original solve input is persisted**
(`ScheduleJob.solve_input_snapshot`, migration 0003,
`app/services/solve_input_serde.py`) specifically so the eventual approval
step doesn't require the caller to resend the entire roster/shift/policy
payload identically, possibly hours later. This is a deliberate, narrow
exception to ADR-0055's "request-supplied, not persisted" posture — see that
ADR's own consequences section, which already anticipated this data outliving
a single request once a real need arose. The snapshot is populated *only*
for `infeasible` jobs (`NULL` otherwise), keeping the exception as narrow as
the actual need.

**`POST /v1/scheduling/jobs/{jobId}/relaxation/approve`** is the entire
approval mechanism — no request body, no way to approve a *different*
relaxation set than what the search already found and reported (a human
wanting something else submits a new job with different inputs, they don't
"customize" an approval). It deserializes the snapshot, re-solves with
exactly the recorded `attemptedCategories` relaxed, and — only on
reproducing a feasible result — persists a real `Schedule`/`ShiftAssignment`
set via the same `_persist_schedule` helper Phase 2/3's normal-solve path
uses, transitions `status` to `completed`, and records `approved: true`,
`approvedAt`, `approvedBy` inside `relaxations_applied`. This is the *only*
code path in this module that ever turns a relaxation option into a real
schedule.

## A real architectural gap found while implementing this

`RELAXATION_SHIFT_LENGTH_BOUNDS` is implemented correctly in the solver
(verified directly by a unit test) but is **structurally unreachable by the
search in this module's actual job-submission flow**: a shift that violates
length bounds is rejected outright at submission time
(`422 INVALID_SHIFT_DEFINITION`, Phase 2's own deliberate design), so such a
job never reaches `infeasible` — and therefore the relaxation search — in
the first place. This is documented in full in ADR-0057 rather than quietly
left for a future reader to notice that this category never appears in a
real `relaxationsApplied` payload. Not fixed in this phase: doing so would
mean reversing Phase 2's own choice to reject malformed shift templates
immediately rather than let the solver discover the problem later as an
opaque infeasibility, and that trade-off is still the right one — a shift
template being wrong is a data-quality problem the caller should learn about
immediately, not something worth modeling as a "relaxable hard constraint."

## Blast radius

- One new nullable column (`schedule_jobs.solve_input_snapshot`, migration
  0003) — additive, no change to any existing row's meaning.
- `job_service.create_job`'s `infeasible` branch gained real behavior (the
  search + snapshot); every other branch (`completed`, `failed`, no
  `solve_input` at all) is unchanged from Phase 2/3.
- `app/solver/model.py`'s constraint-building functions all gained an
  optional `relaxed: frozenset[str] = frozenset()` parameter, defaulting to
  today's exact Phase 2/3 behavior — every existing test (75 before this
  phase) passed unmodified against this change.
- New endpoint, new error code (`RELAXATION_NOT_AVAILABLE`, 409) — no
  changes to any existing endpoint's contract.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Cumulative, not exhaustive-combinatorial, search** (ADR-0057) — bounded
   to at most 4 additional solves per infeasible job, not up to 15 (the
   power set of 4 categories minus the empty set).
2. **The search runs synchronously, inline with the original request** —
   compounding Phase 2's already-flagged synchronous-solving gap (ADR-0055)
   with up to 4 more solves in the worst case (an infeasible job that needs
   every category relaxed). Explicitly not addressed here; Phase 7/8's
   worker-pool infrastructure is where this gets fixed for the whole module,
   not patched locally for just the relaxation path.
3. **Approval re-solves rather than replaying the search's own result
   directly.** The search already found a feasible `SolveResult` when it
   located the winning combination — `approve_relaxation` could in principle
   reuse it directly instead of calling `solve()` again. Re-solving was
   chosen deliberately: it's what actually gets persisted, so it should be
   what actually gets *proven* feasible at approval time (not trusted from
   a search that may be stale by the time a human gets around to approving
   it), and it exercises the exact same `_persist_schedule` code path
   `create_job` uses, rather than a second, parallel persistence path for
   "assignments that came from a stored search result."
4. **A re-solve that unexpectedly fails to reproduce feasibility is a
   `409`, not a `500`.** CP-SAT is deterministic for a fixed model and time
   budget, so this should never happen in practice — but "should never
   happen" isn't the same as "cannot happen" (e.g., environment/version
   drift between when the search ran and when approval happens), and a
   clear, structured domain error is more honest than either silently
   succeeding with stale data or crashing.
5. **The relaxation-approval endpoint takes no request body.** A human
   either approves exactly what was found, or doesn't and submits a new job
   with genuinely different inputs — there's no partial/custom-relaxation
   approval flow, keeping the "never a different set than what was
   presented" guarantee simple to reason about and verify.

## Out of scope for this phase (do not build yet)

- The locked-assignment pre-solve partition (§2.2 rule 1's "fixed vs.
  solvable" split) — Phase 5. Unrelated to relaxation but sequenced next.
- `SchedulingDataProvider` gRPC, the Module 10 explanation-generation
  handoff (this module's own `explanation` string is not the same thing as
  §4/Module 10's AI-generated natural-language explanation) — Phase 6.
- Any async/worker-pool execution model for either the original solve or
  the relaxation search — Phase 7/8, as already flagged in Phase 2.
- Any GraphQL surface for relaxation approval — Node/Module 01's job, fed by
  this phase's REST endpoint; not built here.
