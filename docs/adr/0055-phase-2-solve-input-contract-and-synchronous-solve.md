# ADR-0055: Phase 2 solves synchronously within `POST /v1/scheduling/jobs`, using request-supplied domain data — not the §4.3 gRPC pull

## Context
The module prompt has two statements about how constraint-model inputs reach
the solver that are in tension for this phase specifically:

- §3.1's hard-constraint table talks as if the gRPC pull already exists —
  "pull the active policy via `PolicyService.GetActivePolicy` at solve time."
- §9's own build-phase list schedules that gRPC pull (§4.3's
  `SchedulingDataProvider`, called by the Python solver back into Node) as
  **Phase 6** — after fairness (Phase 3), infeasibility handling (Phase 4),
  and manual-override re-optimization (Phase 5). Phase 2 is scoped only to
  "hard constraint model, single-site scope... get this provably correct."

A CP-SAT model cannot be "provably correct" against nothing — §3.1's
constraints (skill eligibility, leave, contracted hours, labor law, union
rules) all need real typed data to encode and test against. Something has to
give: either Phase 2 builds gRPC client plumbing early (out of the stated
build order), or Phase 2 gets its input some other way.

## Decision
**Two things, decided together:**

1. **The CP-SAT engine (`app/solver/`) is a pure function of typed Python
   domain objects** (`Employee`, `EmploymentPolicy`, `ShiftSlot`,
   `LeaveRecord` — see `app/solver/types.py`), with zero import-time
   dependency on the DB layer, FastAPI, or any network client. This is what
   makes §8's constraint-correctness test suite possible at all: each hard
   constraint gets a synthetic scenario with a known-correct expected
   outcome (`tests/unit/test_solver_constraints.py`), run against the real
   solver, with nothing to mock and nothing flaky (no live Module 01/02
   dependency for a unit test to depend on network reachability for).
2. **`POST /v1/scheduling/jobs` accepts this data directly in the request
   body** (`roster`, `shiftSlots`, `policy`, `leaveRecords` — see
   `app/api/v1/schemas.py`) and solves **synchronously**, inline in the
   request, for this phase's single-site/bounded scope. This is the same
   move Module 03 made in its own Phase 1 (`POST
   /v1/forecasting/actuals` accepted data directly, before any cross-service
   pull existed) — an honest, real, working end-to-end path now, explicitly
   understood to be superseded, not layered under, once the real data
   source exists.

Phase 6 (§4.3, unchanged from the module prompt's own build order) replaces
*how this data arrives* — a `SchedulingDataProvider` gRPC pull from Module
01/02/03 instead of the caller assembling and posting it — without touching
`app/solver/`'s constraint logic at all. The pure-engine boundary drawn now
is exactly what makes that swap a plumbing change later, not a rewrite.

## Consequences
- **The request contract is heavier than Phase 1's.** `ScheduleJobRequest`
  now requires a full roster/shift/policy payload, not just
  `orgUnitId`/`dateRange`/`forecastRunId`. This is explicitly a Phase 2
  scaffold, not the platform's real integration shape — Phase 6 is expected
  to slim this back down once the solver can source its own inputs. Noted
  here so nothing downstream (GraphQL, a future UI) is built assuming this
  request shape is permanent.
- **Synchronous solving inside an HTTP request is a real, stated gap against
  §0.5's own SLOs.** §0.5 states single-site solve p95 < 3 minutes as a
  target; blocking an HTTP request for up to 3 minutes is not acceptable for
  a production API. Phase 2 accepts this because (a) there is no worker-pool
  infrastructure to solve asynchronously against yet (that's implicitly
  Phase 7/8 territory - decomposition and deployment topology), and (b) the
  synthetic/small-scope scenarios this phase is provably correct against
  solve in milliseconds, not minutes. `SolveInput.time_limit_seconds`
  (default 30s) bounds the worst case so a pathological input can't hang the
  request forever; a bounded-but-inconclusive solve returns
  `status: unknown` -> `failed`, never a hung connection. Flagged explicitly
  in the Phase 2 production readiness checklist as unresolved, not silently
  accepted as "the design."
- **`ScheduleJob.status: unknown` from CP-SAT maps to `failed`, not
  `infeasible`.** Per the module prompt's own rule (§2.2 rule 2, §5): a
  proven absence of any feasible schedule is `infeasible` (CP-SAT
  `INFEASIBLE`); "the solver ran out of time with neither a solution nor a
  proof that none exists" is a different, weaker claim, and conflating it
  with `infeasible` would be exactly the kind of vague sufficiency claim the
  module prompt's §0 forbids. This distinction has no relaxation-decision
  consequence yet (§5's relaxation flow is Phase 4) but the status is
  recorded correctly now so Phase 4 doesn't have to retrofit it.
