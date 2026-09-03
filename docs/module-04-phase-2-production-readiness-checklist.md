# Module 04 Phase 2 Production Readiness Checklist

Same honesty bar as Phase 1's checklist. This module carries the platform's
highest engineering risk (§0) — a constraint-model bug here is a legal-
liability bug, not a UX bug, so this checklist is deliberately conservative
about what "done" means.

## Delivered in this phase (application code)

- [x] Every §3.1 hard constraint encoded directly in CP-SAT: skill
      requirement and leave/unavailability (eligibility gating — no decision
      variable exists for an ineligible pair), minimum rest between shifts
      and no-double-booking (one pairwise conflict check), maximum
      consecutive working days (rolling-window sum over "worked" indicators),
      contracted hours vs. overtime-approval (hard per-calendar-week cap),
      union rules on shift length/mandatory break (pre-solve template
      validation, `422 INVALID_SHIFT_DEFINITION` on violation).
- [x] §8's constraint-correctness test suite: 17 synthetic scenarios in
      `tests/unit/test_solver_constraints.py`, one (or a feasible/infeasible
      pair) per hard constraint, run against the real CP-SAT solver — no
      mocking of the solver itself, only the input data is synthetic.
- [x] Coverage as a structural precondition (`>=`, not `==`) so the model has
      a genuine reason to assign anyone to anything, without over-
      constraining overstaffing (Phase 3's job once cost-minimization
      exists).
- [x] `POST /v1/scheduling/jobs` wired to the solver: a request with
      `policy`+`shiftSlots` solves synchronously to a real terminal state
      (`completed` with a persisted `Schedule`/`ShiftAssignment` set,
      `infeasible`, or `failed` — never conflated with each other). A
      request without them keeps Phase 1's exact `queued`-forever behavior,
      verified regression-free by re-running Phase 1's own integration suite
      unmodified against this phase's code.
- [x] New `GET /v1/scheduling/jobs/{jobId}/schedule` read endpoint (this
      service's own minimal REST readback — not §4.2's GraphQL surface,
      which is Node/Module 01's to build later off this service's events).
- [x] Two real bugs found by actually running the test suites against real
      Postgres, not assumed correct from code review — both fixed and
      documented (design doc, ADR-0054's update): (1) the contracted-hours
      cap was prorating a weekly limit by the solve's date-range span
      instead of bucketing per calendar week; (2) `ShiftAssignment.locked`'s
      SQLAlchemy mapping tried to `INSERT` a value into a `GENERATED ALWAYS`
      column, which Postgres correctly rejected.
- [x] `ruff`/`mypy --strict` clean across the new `app/solver/` package and
      every touched file; `mypy`'s `python_version` bumped to 3.12 (Phase 2's
      `ortools` dependency pulls in a `numpy` whose stubs need it) — a real,
      documented reason, not a blanket loosening.
- [x] Full suite (52 tests: unit + integration, Phase 1 and Phase 2
      combined) run and passing against a real shared Postgres and a real
      local NATS+JetStream broker, not just asserted from static review.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Anything about soft constraints, cost, or fairness.** No objective
      function exists at all yet — Phase 2 only proves feasibility/
      infeasibility against hard constraints. Do not read "the solver
      produces a schedule" as "the solver produces a *good* schedule" —
      there is currently no notion of quality beyond hard-constraint
      satisfaction.
- [ ] **Real infeasibility handling (§5).** `status: infeasible` is reported
      correctly and distinctly from `failed`, but nothing relaxes anything,
      proposes an alternative, or surfaces a structured explanation yet —
      that's Phase 4 in full, not started here.
- [ ] **The gRPC data pull (§4.3).** Solve input is request-supplied
      (ADR-0055) — a real, working, but explicitly interim mechanism. Any
      caller of this API today must assemble the full roster/policy/shift
      payload itself; there is no "the service figures out who's
      schedulable" path yet.
- [ ] **Solving off the request thread.** Synchronous, in-request CP-SAT
      solving is a real gap against §0.5's own p95 < 3 minute SLO for
      single-site scope — there is no worker pool, no queue consumer, and no
      protection against a request that takes minutes to solve blocking that
      connection for the duration. `time_limit_seconds` (30s default) is the
      only backstop. Do not point real traffic at this endpoint with
      nontrivial roster/shift counts before this is addressed.
- [ ] **Scale validation of any kind.** The pairwise no-conflict constraint
      construction is `O(employees × shifts²)` per employee — untested past
      the correctness suite's small synthetic scenarios. No load test, no
      decomposition, no data point on where this stops being "single-site
      scope" and starts timing out. Phase 7's explicit job, not assumed fine
      by extrapolation.
- [ ] **The pre-solve locked/fixed partition step.** The `locked` generated
      column (Phase 1, ADR-0054) is correct and now correctly mapped, but
      nothing reads it yet — every solve in this phase starts from a blank
      slate. Phase 5.
- [ ] **Any GraphQL surface, any UI-facing shape.** §4.2's `Schedule`/
      `ShiftAssignment` GraphQL types are still entirely unbuilt (Node's job,
      fed by this service's events) — the new REST readback endpoint is a
      Python-service-internal convenience, not the platform's real
      integration surface.
- [ ] **Terraform, Vault, `pg_partman`, rate limiting, SAST/SBOM,
      penetration testing.** Same explicit non-goals already stated
      platform-wide and per-module in every prior phase's checklist — not
      re-litigated here.
