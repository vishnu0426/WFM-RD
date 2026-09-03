# Module 04 Phase 3 Production Readiness Checklist

Same honesty bar as Phases 1-2. This module carries the platform's highest
engineering risk (§0); this checklist stays conservative about what "done"
means, especially now that fairness — a genuine legal/compliance surface —
is live.

## Delivered in this phase (application code)

- [x] §3.2's four soft constraints (preference, cost/overtime + coverage-
      excess, skill decay, cross-skill balance) as CP-SAT objective terms,
      each independently tenant-configurable and independently switchable
      off via a zero weight.
- [x] §3.3's fairness bound as a genuine hard CP-SAT constraint — proven
      capable of making a job *infeasible* by itself
      (`test_fairness_bound_is_infeasible_when_tolerance_cannot_absorb_existing_imbalance`,
      and the full cross-run integration test), never a tradeable objective
      term.
- [x] `fairness_ledger` table (migration 0002), partitioned `RANGE` monthly
      on `shift_start` like `shift_assignments` (ADR-0053), RLS, grants.
- [x] `POST /v1/scheduling/schedules/{scheduleId}/publish` — the §3.3
      `FairnessLedger` refresh trigger, draft→published only, rejects
      double-publish with `409 SCHEDULE_NOT_PUBLISHABLE`.
- [x] `GET /v1/scheduling/fairness/audit` — the module prompt's own named
      compliance-auditor query, exercised end to end (real counts, real
      tolerance-violation flags) against a real published ledger.
- [x] **End-to-end proof that fairness genuinely spans schedule runs**, not
      just one solve: publish job A's schedule, then submit job B (a
      separate solve, later date) and show its feasibility is governed by
      history job A wrote — the literal §3.3 promise, proven against real
      Postgres/NATS, not asserted from the constraint code alone.
- [x] `ConstraintConfigInput` gives `ScheduleJob.constraint_config` the
      concrete validated shape Phase 1's own design doc committed Phase 3
      to delivering.
- [x] Five real bugs found by actually running the suites against real
      Postgres/HTTP (not assumed correct from code review), all fixed and
      documented (design doc, ADR-0056): a missing anti-overstaffing
      objective term, an overly strict DB CHECK constraint
      (`published_by` required unconditionally, inconsistent with this
      platform's no-auth-yet posture), a genuine SQLAlchemy `insertmanyvalues`
      sentinel-matching failure affecting both this phase's new table *and*
      a latent Phase 2 bug in `ShiftAssignment` persistence, a naive-datetime
      timezone bug in test fixtures, and a camelCase/snake_case
      inconsistency in one endpoint's query parameters.
- [x] `ruff`/`mypy --strict` clean; full suite (66 tests: unit + integration,
      Phases 1-3 combined) passing against a real Postgres and a real local
      NATS+JetStream broker.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Infeasibility relaxation (§5).** A fairness-driven `infeasible`
      result is reported correctly and distinctly, but nothing proposes a
      relaxation, orders relaxation categories, or gates one behind human
      approval yet — Phase 4 in full.
- [ ] **The root cause of ADR-0056's SQLAlchemy `insertmanyvalues` failure
      is only partially diagnosed**, not fully understood. The raw-`text()`
      workaround is verified correct and is expected to remain correct
      regardless of the underlying cause, but "why does this specifically
      reproduce through `TestClient` and not a bare asyncio script" remains
      an open question, flagged rather than silently assumed resolved.
- [ ] **Raw `text()` INSERT column lists are hand-maintained, not derived
      from the ORM model** (ADR-0056's accepted trade-off) — a column added
      to `shift_assignments`/`fairness_ledger` in a future migration without
      also updating `job_service.py`/`schedule_service.py`'s raw SQL strings
      will silently omit that column from new rows, with no compiler/mypy
      check to catch it. A real, not hypothetical, maintenance gap.
- [ ] **`constraint_config`'s history is reconstructable but not directly
      queryable as its own timeline.** The audit endpoint's `tolerance` is
      caller-supplied, not auto-derived from "whatever `ScheduleJob.
      constraint_config` said at the time" — an auditor can still get there
      by joining `FairnessLedger.schedule_id` → `ScheduleJob.constraint_config`
      by hand, but there's no endpoint that does that join automatically yet.
- [ ] **Cross-skill balance's fairness proxy (distinct-employee-count) is a
      simplification**, not a min-max-concentration guarantee. Documented as
      a deliberate scope choice (design doc), not silently assumed to be the
      strongest possible formulation.
- [ ] **No scale/performance data for the fairness constraint or the
      `FairnessLedger` query at real employee counts.** The pairwise
      no-conflict constraint's `O(employees × shifts²)` scaling concern from
      Phase 2 is unchanged and now joined by the fairness constraint's own
      `O(employees)` linear-but-still-untested-at-scale terms — Phase 7's
      job, not assumed fine by extrapolation.
- [ ] **The locked-assignment pre-solve partition, gRPC data pulls, any
      GraphQL surface, decomposition, zero-downtime deploys** — unchanged
      from Phase 2's own list, still Phases 5-8.
