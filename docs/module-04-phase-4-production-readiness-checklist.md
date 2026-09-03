# Module 04 Phase 4 Production Readiness Checklist

Same honesty bar as Phases 1-3. This module carries the platform's highest
engineering risk (§0); this checklist stays conservative, especially now
that this phase governs exactly which labor-law/contractual protections can
ever be traded away and under what human oversight.

## Delivered in this phase (application code)

- [x] §5's relaxation search, four categories, cost-ascending
      (ADR-0057): contracted hours, shift length bounds, minimum rest
      between shifts, maximum consecutive working days.
- [x] A documented, reviewed non-relaxable set: skill requirement, leave/
      unavailability, shift-overlap prevention, mandatory break placement —
      never relaxed automatically, at any human's approval, by this flow.
- [x] §5 point 3's structured, queryable payload
      (`ScheduleJob.relaxations_applied`): attempted categories, feasibility,
      a category-specific cost summary (affected employees/shifts, exact
      magnitude - additional overtime minutes, actual vs. required rest
      hours, consecutive days worked vs. allowed), and a generated
      human-readable explanation — not a free-text string standing alone.
- [x] §5 point 4's non-negotiable, enforced structurally: `ScheduleJob.status`
      never leaves `infeasible` on its own; the only code path that ever
      produces a real `Schedule` from a relaxation is
      `POST /v1/scheduling/jobs/{jobId}/relaxation/approve`, a human-invoked
      endpoint with no auto-trigger anywhere in this codebase.
- [x] `schedule_jobs.solve_input_snapshot` (migration 0003) — populated only
      for `infeasible` jobs, round-trip-tested byte-for-byte
      (`test_solve_input_serde.py`), enabling approval to re-solve without
      the caller resending the original payload.
- [x] End-to-end proof against real Postgres/NATS: an infeasible job records
      a correct, specific relaxation option; approving it produces a real,
      persisted `Schedule` with correctly attributed `isOvertime`; approving
      twice is rejected (409); approving an already-feasible job's
      "relaxation" is rejected; approving a job with no feasible relaxation
      (skill requirement, never relaxable) is rejected with a clear reason;
      approving a nonexistent job 404s.
- [x] A real, documented architectural gap found and not silently patched
      over: `shift_length_bounds` relaxation is correct in isolation
      (unit-tested directly) but structurally unreachable by the search in
      this module's current job-submission flow, since a too-short/too-long
      shift is rejected at submission time, before any solve — see
      ADR-0057's "structural gap" section and the design doc.
- [x] Every existing Phase 1-3 test (75) still passes unmodified against
      this phase's changes — the relaxation machinery is additive, not a
      rewrite of the existing solve path.
- [x] `ruff`/`mypy --strict` clean; full suite (81 tests) passing against a
      real Postgres and a real local NATS+JetStream broker.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **ADR-0057's relaxation ordering and non-relaxable set is this
      module's own judgment call**, not a jurisdiction-specific labor-law
      determination. A real deployment's legal/compliance function should
      review this specific ordering (and, in particular, whether
      minimum-rest and maximum-consecutive-days should be relaxable at all
      in their specific jurisdiction/union contracts) before this module
      auto-generates relaxation options a Scheduler/Planner might approve
      without independent legal review of their own.
- [ ] **The relaxation search adds up to 4 additional synchronous solves to
      an already-synchronous, already-flagged request path.** An infeasible
      job that needs every category relaxed now takes up to 5x a single
      solve's wall-clock time, still inside one HTTP request, still with no
      worker-pool infrastructure to move this off the request thread — a
      real, compounding version of the gap Phase 2's own checklist already
      flagged, not newly introduced but made materially worse.
- [ ] **No scale data for the relaxation search itself.** Every category's
      cost-summary computation re-scans the full assignment/shift set per
      category; untested past this phase's small synthetic scenarios, same
      "Phase 7's job" caveat as the rest of this module's scale claims.
- [ ] **`solve_input_snapshot` has no retention/expiry policy.** An
      `infeasible` job whose relaxation is never approved keeps its full
      roster/shift snapshot indefinitely — no cleanup job, no TTL, flagged
      as a real (if currently small-scale) storage-growth gap, same category
      as `audit_log`/`forecast_data_points`/`shift_assignments`/
      `fairness_ledger`'s already-accepted "no production partition
      rotation yet" gaps.
- [ ] **The locked-assignment pre-solve partition, gRPC data pulls, any
      GraphQL surface, decomposition, zero-downtime deploys** — unchanged
      from Phase 3's own list, still Phases 5-8.
