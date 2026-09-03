# ADR-0082: `SchedulingEligibilityService` gives Module 07 a real, synchronous single-assignment constraint check - scheduling-service's first gRPC server

## Context
Module 07 (Shift Marketplace)'s entire design center of gravity, per its own
module prompt §0, is that its guardrail validation re-validates claims/swaps
against Module 04's *exact* constraint logic, via the same calls Module 04's
own solver uses - never a separately maintained rule set - and that if a
constraint type isn't yet exposed as a callable check, the correct move is
to block that marketplace action type rather than approximate it.

Investigating what Module 04 (scheduling-service) actually exposes before
building Module 07 found that no such check exists, in any form:
scheduling-service has no gRPC server at all (it is exclusively a gRPC
*client* of Module 01/02/03/06), and its only reoptimization path is the
async job queue ADR-0060 established - `POST .../reoptimize` enqueues a
`ScheduleJob` row and returns `202 {jobId, status: "queued"}`; nothing runs
CP-SAT, or any constraint check, on the request thread, and there is no way
to ask "would this one assignment violate a hard constraint?" without
submitting and polling a full re-optimization job. Module 07 cannot build
its signature mechanism against that: a claim's fast-fail lock-loser path
and its p99 < 500ms guardrail-validation SLO both need a real answer in
milliseconds, not a job to poll.

Two ways forward were considered: (a) ship Module 07 with hard-constraint
re-validation permanently blocked/unavailable, mirroring ADR-0076's
permanent-null posture for the org-coverage check Module 02 also doesn't
expose, or (b) close the gap in scheduling-service directly, the same way
Module 06 Phase 5 (ADR-0078) closed ADR-0059's leave-data gap by exposing a
new `LeaveService.GetUnavailability` RPC. (b) was chosen: Module 07's own
value proposition (letting employees claim/swap shifts with a real, trusted
compliance guarantee) is hollow without it, and the underlying check turns
out to be genuinely cheap - see Decision below.

## Decision

**New RPC**: `agno.scheduling.v1.SchedulingEligibilityService.CheckAssignmentEligibility`
(`scheduling-service/app/grpc/proto/scheduling_eligibility.proto`) - unary,
tenant-scoped, no HTTP middleware binding tenant context (bound per-call
from the request message, same posture as `ForecastServicer`/ADR-0059).
Takes `tenant_id`, `candidate_employee_id`, `shift_assignment_id` (the
target shift - scheduling-service's own persisted `ShiftAssignment` row is
the single source of truth for its start/end/skill, so the caller never
supplies shift metadata that could be stale or tampered with),
`org_unit_id`, and an optional `exclude_shift_assignment_id` (a swap's
give-up side, excluded from the candidate's "existing assignments" set so
it doesn't conflict with itself). Returns `eligible`, a
`shift_assignment_found` sentinel (false = the post is stale, never treated
as "eligible" by default), and a `repeated EligibilityViolation {category,
detail}` - a structured, per-category reason, not a generic pass/fail,
matching Module 07's own §2.2 rule 2 requirement to surface "a clear reason
on rejection, not just a generic failure."

**Never invokes `app.solver.model.solve()`/CP-SAT** - the new
`app/solver/eligibility.py` module evaluates the same predicates the CP-SAT
constraints encode, against one candidate assignment and the employee's own
already-persisted assignments, with no decision-variable model at all:
- `_is_eligible`/`_conflicts` (`app/solver/model.py`) are imported and
  called **verbatim** - both were already pure, model-free functions
  (confirmed by that module's own docstring and `test_solver_constraints.py`
  exercising them with no CP-SAT model involved), so there was nothing to
  re-express for skill/leave/overlap/min-rest.
- Max-consecutive-days and contracted-hours have **no standalone form** in
  `model.py` - `_add_max_consecutive_days_constraints`/
  `_add_contracted_hours_constraints` express the identical window/cap
  arithmetic only as `model.add(sum(vars) <= cap)` CP-SAT constraints over
  decision variables, which cannot be evaluated without a model+solver.
  `app/solver/eligibility.py`'s `_would_exceed_max_consecutive_days`/
  `_would_exceed_contracted_hours` are a **faithful, narrow re-expression**
  of that same arithmetic (identical window size
  `max_consecutive_days + 1`, identical per-ISO-week minute bucketing)
  against concrete dates/assignments instead of decision variables - not an
  independently-designed rule set. This is a real, bounded exception to
  "never reimplement," scoped to two pieces of pure arithmetic, not the
  constraint logic itself.
- **Drift guard**: `tests/unit/test_eligibility.py` runs synthetic
  scenarios through both the real `solve()` and
  `evaluate_assignment_eligibility()` and asserts they agree on
  feasibility for both re-expressed checks. A future change to either
  side's window/cap arithmetic that silently diverges from the other fails
  this test, rather than shipping a quiet mismatch between what the
  marketplace approves and what a re-optimization would have accepted.

**Data sourcing**: the target shift and the candidate's other assignments
come from scheduling-service's own `shift_assignments` table (reusing
`schedule_service.list_employee_shift_assignments`, published-schedule-only,
same as every other reader of that table); `Employee`/`EmploymentPolicy`/
`LeaveRecord` are pulled live via the existing `employee_client`/
`policy_client`/`leave_client` gRPC clients (`app/grpc_clients/`) against
Module 01/02's core channel and Module 06's attendance channel - the exact
same clients `solve_input_resolver.py` already uses per-solve, reused
as-is, not duplicated. This means the RPC's actual latency is bounded by
upstream gRPC health (each client already retries transient failures via
`retry.py`'s 100/400/1600ms backoff, ~2.1s worst case), not purely local
computation - a real constraint on Module 07's p99 < 500ms guardrail SLO
that its own load test should validate against, not assume away.

**Hosted in the same process as the FastAPI app** (`app/main.py`'s
`lifespan`, a second `grpc.aio.server()` alongside the existing NATS
connection), not `app/worker.py` - this RPC is deliberately not CPU-bound
(no CP-SAT call), so it doesn't reintroduce the request-thread solving
ADR-0060 moved out, and has no reason to live in the worker's separate
process. Bind address is a new config field, `scheduling_grpc_bind_address`
(default `0.0.0.0:8102` - `port` (8100) and `worker_metrics_port` (8101)
already claim the two adjacent values).

## Consequences
- scheduling-service gains its first gRPC **server** (previously
  client-only) and a new generated-stubs directory, `app/grpc/generated/`,
  alongside its existing client-stub directory, `app/grpc_clients/generated/`
  - the naming asymmetry (`grpc/` vs `grpc_clients/`) is deliberate, not an
  inconsistency: it mirrors forecasting-service's own `app/grpc/` layout for
  the server side, keeping outbound-client and inbound-server generated code
  in genuinely separate directories rather than merging two different
  lifecycles into one.
- Module 07 can now build its signature concurrency-safe claim flow against
  a real synchronous guardrail check, with no blocked action types on this
  axis - the org-coverage gap ADR-0076 documented for Module 02 is a
  separate, still-open gap (this ADR does not close it); Module 07's bid/
  claim eligibility resolution for org-coverage specifically remains
  blocked/not-evaluated until Module 02 exposes it, per Module 07's own
  design rule.
- The two re-expressed arithmetic checks are a tracked coupling risk, not a
  one-time cost: any future change to `_add_max_consecutive_days_constraints`/
  `_add_contracted_hours_constraints`'s semantics (e.g. a new relaxation
  category, a different window definition) must update
  `app/solver/eligibility.py` in the same change, and
  `test_eligibility.py`'s cross-validation tests are the mechanism that
  catches a missed update - not code review alone.
- This RPC's correctness depends on scheduling-service's own
  `shift_assignments` table being current for the candidate employee at
  call time - it reads live, not from any cache, so it is not vulnerable to
  the same staleness class of bug a cached roster/policy snapshot would
  introduce, at the cost of one more live DB read plus three live gRPC
  pulls per claim attempt (bounded by Module 07's own Redis lock, so at
  most one such read per contested post at a time, not one per losing
  claimant).
