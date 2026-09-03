# Module 04 Phase 5 Production Readiness Checklist

Same honesty bar as Phases 1-4. This phase is where §2.2 rule 1 — the rule
that a human's manual decision can never be silently re-solved away — goes
from a schema-level invariant (`locked`, Phase 1) to something actually
reachable end to end.

## Delivered in this phase (application code)

- [x] `POST /v1/scheduling/schedules/{scheduleId}/assignments/{assignmentId}/override`
      — reassigns an existing `ShiftAssignment`, sets `assignment_source:
      manual_override`, `locked` follows automatically from the `GENERATED
      ALWAYS` column (ADR-0054). No eligibility re-validation (deliberate —
      see the design doc's assumptions).
- [x] `double_booking` conflict detection on override, writing a real
      `ScheduleConflict` row (`conflict_type`, `affected_employee_id`,
      `status: open`) — the first phase to ever populate this table.
- [x] `GET /v1/scheduling/schedules/{scheduleId}/conflicts` — added so a
      written conflict is actually reachable over HTTP, not a table only
      this phase's own write path ever touches.
- [x] `SolveInput.locked_assignments` (ADR-0058): every locked pair gets an
      unconditionally-created decision variable (bypassing skill/leave
      eligibility) forced to `1`. Verified directly: eligibility bypass,
      unknown-employee/unknown-shift validation
      (`UnknownLockedAssignmentError`), locked-locked conflict skip,
      locked-vs-solvable conflict still enforced, effective-cap/window
      adjustment for both contracted hours and max consecutive days (11
      dedicated solver-level unit tests, `test_solver_locked_assignments.py`,
      run against the real CP-SAT model, no mocking).
- [x] `POST /v1/scheduling/schedules/{scheduleId}/reoptimize` — a new solve
      with its own `ScheduleJob`, matching locked assignments into the
      request's own `shiftSlots` by `(start, end, requiredSkillId)`, same
      `Idempotency-Key`/completed/infeasible/failed/relaxation-search
      machinery as `POST /v1/scheduling/jobs`. Verified end to end against
      real Postgres/NATS: an override survives a reoptimize with its
      `assignment_source` intact while the rest of the schedule re-solves
      freely; a reoptimize omitting a locked shift's definition is rejected
      (422); a reoptimize omitting a locked employee from the roster is
      rejected (422); a reoptimize replays idempotently on the same key; a
      double-booking override is detected and readable back via the
      conflicts endpoint; overriding a nonexistent assignment 404s.
- [x] A real correctness bug found and fixed before it could ship:
      `approve_relaxation`'s manually-enumerated `SolveInput(...)`
      reconstruction would have silently dropped `locked_assignments` on a
      reoptimize-job's later-approved relaxation, un-forcing a human's
      override on re-solve. Fixed by switching to `dataclasses.replace`,
      which carries every field (present and future) forward automatically.
      `solve_input_serde.py` extended to round-trip `locked_assignments`
      (with `assignment_source`) through the jsonb snapshot; covered by a
      dedicated round-trip test.
- [x] A real bug found by this phase's own integration tests, not left for
      a future one to hit: a bare post-flush access of `ShiftAssignment.
      locked` (a `GENERATED ALWAYS` column, expired on `flush()`) raised
      `sqlalchemy.exc.MissingGreenlet` — fixed with an explicit `await
      session.refresh(...)` inside the service function.
- [x] Every existing Phase 1-4 test (92) still passes unmodified against
      this phase's changes — the locked-assignment machinery is additive
      (every new parameter defaults to empty/unchanged behavior).
- [x] `ruff`/`mypy` clean; full suite (99 tests: 81 pre-Phase-5 + 11 new
      solver unit tests + 7 new integration tests, including this phase's
      own two bug-fix regression tests) passing against a real Postgres and
      a real local NATS+JetStream broker.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **No schedule-versioning/archival lifecycle.** Reoptimizing never
      touches the source schedule's own status — no auto-archive, no
      explicit archive/supersede endpoint. A real deployment needs an
      answer to "what happens to the old schedule and its own
      `FairnessLedger` rows if it was already published" before this phase's
      reoptimize flow is safe to expose broadly — see the design doc's
      assumption #1. This is a real, currently-open gap, not a deferred nice-
      to-have.
- [ ] **Override performs no eligibility/roster validation against the new
      employee id at all** (design doc assumption #3) — this service has no
      local employee data to validate against (ADR-0055), so a bad/
      nonexistent employee id in an override request is accepted and
      persisted without complaint. Phase 6's gRPC pull is what would let
      this validate against Module 02's real roster.
- [ ] **`skill_gap`/`leave_overlap`/`overtime_breach` conflicts are not
      detected** — only `double_booking`. Same Phase 6 data-availability gap
      as the point above; flagged in ADR-0058 from the start of this phase,
      not discovered late.
- [ ] **Reoptimize is still a fully synchronous request**, same
      already-flagged gap as every prior phase's solve path (Phase 2's own
      checklist), now with a third endpoint sharing it.
- [ ] **No authorization check on override/reoptimize/publish beyond tenant
      isolation.** §4.2 names an explicit scheduler/manager permission
      scoped to `org_unit_id` for `overrideAssignment`/`publishSchedule` —
      this service has no ABAC enforcement of its own (Module 01's job);
      any caller that can reach this service for a given tenant can
      override/reoptimize/publish any schedule in that tenant regardless of
      `org_unit_id` scope. Unchanged from every prior phase's posture on
      authorization, restated here because this phase adds two more
      mutating endpoints to that same gap.
- [ ] **gRPC data pulls, decomposition, zero-downtime deploys** — unchanged
      from Phase 4's own list, still Phases 6-8.
