# ADR-0059: Phase 6 mid-solve gRPC data pulls - optional-field triggers, retry/backoff, and the policy-definition contract Module 01/02 never pinned down

## Context
§4.3 requires this module to replace ADR-0055's request-supplied roster/
policy data with real mid-solve gRPC pulls into Module 01 (`PolicyService`),
Module 02 (`EmployeeService`), and Module 03 (a `ForecastService` this ADR
also has to create, since it doesn't exist yet - see below), scoped by
`org_unit_id`/`date_range`, never a bulk upfront payload. Four separate,
real gaps surfaced while grounding this in the actual running platform
rather than an assumed one:

1. **`GetForecastRequirements` doesn't exist anywhere.** Module 03
   (`forecasting-service`) has no gRPC surface at all - `EmployeeService`/
   `PolicyService`/`CalendarService` (Module 01/02, `src/grpc/`) are real,
   already-running code; Module 03 is REST-only. The module prompt assumes
   this contract is "already defined in those modules' prompts" - it isn't.
2. **Module 01/02's `Policy.definition` (the four employment `policy_type`
   values `PolicyService.GetActivePolicy` serves) has no pinned-down JSON
   shape anywhere in the platform.** `policy.proto` documents it as
   "arbitrary shape per §2.1 rule 4" and nothing in Module 01/02's own code
   validates or documents field names beyond `Record<string, unknown>`/
   `IsObject()`. This module is the first real consumer that needs to parse
   it, so this module has to be the one to define the contract.
3. **No real leave/unavailability source exists anywhere in the platform**
   - Module 02's `CalendarService.GetWorkingTimeRules` is org-wide holidays
     only, not per-employee leave, and Module 06 doesn't exist. Phase 2's
     interim posture (request-supplied `LeaveRecord`, ADR-0055) has nowhere
     else to go; this is unchanged by this phase, permanently, until
     Module 06 ships.
4. **The shared local Postgres this session actually runs against had
   Module 01/02's own migrations only partially applied** (a stray empty
   `core.tenants` table with no migration-tracking row, and the `agno_app`/
   `agno_forecasting_app` roles missing entirely) - fixed as a prerequisite
   (dropped the empty stray table, created the two missing roles, then ran
   Module 01/02's real TypeORM migrations clean) so this phase's own
   integration tests run against the platform's actual schema, not a
   half-provisioned one. Recorded here since it's a real fix this phase
   needed, not a Module 04 code change.

## Decision 1: build `ForecastService.GetForecastRequirements` in `forecasting-service` now
`ForecastDataPoint.required_headcount` (Phase 5/ADR-0023's Erlang C output)
is already exactly the data this RPC needs to serve - a read, not new
computation. New `forecasting-service/app/grpc/proto/forecast.proto`
(package `agno.forecasting.v1`), **unary**, not server-streaming - unlike
`EmployeeService.GetSchedulableEmployees`'s genuinely unbounded org-unit
employee count (100k+ scale per §0.5), a single `ScheduleJob`'s own date
range bounds the interval count to a realistic scheduling horizon, and
unary lets `found`/not-found (`PolicyResponse`'s own pattern) live as one
response field rather than an awkward sentinel on an otherwise-empty
stream. Explicit `tenant_id` request field (ADR-0021's established pattern
- no HTTP middleware to bind tenant context from a gRPC call). Implemented
with `grpc.aio` (Python's async gRPC, matching this service's existing
`asyncio`/`asyncpg` stack) rather than `@nestjs/microservices`' dynamic
proto loading (a Node-specific mechanism) - stubs generated once via
`grpc_tools.protoc` and checked in, regenerated via a documented command in
the proto file's own header, since Python has no runtime
dynamic-proto-loading equivalent as convenient as `@grpc/proto-loader`.

Keyed by `forecast_run_id` directly, not `org_unit_id`/date range - every
`ScheduleJob` already carries `forecast_run_id` (§2.1, required since
Phase 1, unused for anything until now), so there is no "which run did the
caller mean" ambiguity to resolve the way an org-unit/date-range lookup
would invite (multiple completed runs can legitimately exist for the same
org unit/range). `found: false` (mirroring `PolicyResponse`'s own
convention) when the run doesn't exist, isn't `tenant_id`-scoped to the
caller, or isn't `status: completed` yet - a scheduling job pulling
requirements from a still-`running`/`failed` forecast is a caller error to
surface clearly, not data to guess at from a partial run.

## Decision 2: optional-field triggers pull, never a forced replacement
`ScheduleJobRequest.roster` and `.policy` become optional (already `list`/
`| None`-shaped in Pydantic terms); when omitted, this service pulls them
via gRPC. When supplied, the request body wins outright - no merge, no
"gRPC as default, request as override for individual fields." Two reasons:

- **Backward compatibility with every existing test and caller.** All 99
  Phase 1-5 tests supply full roster/policy/shiftSlots explicitly; none of
  them should need a live Module 01/02/03 gRPC server just to keep passing.
  Making the pull additive-only (triggered by *absence*, not by a new flag)
  means the entire existing test suite is unaffected by this phase, with
  zero regressions to reconcile.
- **A real "what-if" use case.** A Scheduler/Planner exploring a scenario
  ("what if I had two more people") supplying a modified roster directly is
  a legitimate manual override of what Module 02 currently has on file -
  not a bug to prevent, the same trust-the-caller posture ADR-0058 already
  established for manual overrides at the assignment level.

`ShiftSlot.requiredHeadcount` similarly becomes optional per-shift: when
omitted, derived from `GetForecastRequirements` as the **max** of
`required_headcount` across every forecast interval whose `interval_start`
falls within `[shift.start, shift.end)` - a shift must be staffed for its
peak interval, not its average one. When supplied, the request value wins,
same override reasoning as above.

`leaveRecords` is **not** made optional/pullable - there is nothing to pull
it from (Decision on the permanent gap, above). It stays exactly what
ADR-0055 already made it: request-supplied, always.

## Decision 3: the employment-policy `definition` JSON contract (this module's own, since nobody else defined one)
Only two of the four employment `policy_type` values map onto anything
`EmploymentPolicy` (this module's dataclass) needs -
`OVERTIME_THRESHOLD` has no corresponding field here (`contract_hours_per_week`
lives on `Employee`, pulled via `EmployeeService`, not a policy at all; see
§3.1's own table, which sources "contracted hours" from `Employee`, not a
policy). This module fetches and parses exactly three:

| `policy_type` | `definition` shape this module expects | Maps to |
|---|---|---|
| `rest_period_minimum` | `{ "minRestHoursBetweenShifts": number }` | `EmploymentPolicy.min_rest_hours_between_shifts` |
| `max_consecutive_days` | `{ "maxConsecutiveWorkingDays": number }` | `EmploymentPolicy.max_consecutive_working_days` |
| `union_rule` | `{ "minShiftLengthMinutes": number, "maxShiftLengthMinutes": number\|null, "mandatoryBreakAfterHours": number\|null, "mandatoryBreakMinutes": number\|null }` | the four matching `EmploymentPolicy` fields |

`union_rule` bundling shift-length + break-placement fields together,
rather than three separate policy types, directly matches §3.1's own table
("Union rules | `EmploymentPolicy.union_rule` | Minimum shift length,
mandatory break placement"). **A tenant/admin writing one of these three
policy rows via Module 01's `createEmploymentPolicy` mutation must use this
exact shape** - nothing in Module 01/02 validates this today (`IsObject()`
only), so a malformed `definition` fails soft (see Decision 4), not loud, at
solve time. Flagged in the readiness checklist as a real cross-module
contract that needs either a shared schema or Module 01-side validation
before this is safe to rely on broadly.

## Decision 4: missing/malformed policy data fails soft to a platform default, per field, independently
`PolicyService.GetActivePolicy` returning `found: false` (no row configured
for this org unit/type) is expected, not exceptional - most tenants won't
configure all three types on day one. Each of the three types has its own
independent platform default (min rest 8.0h, max consecutive days 6, union
rule "no minimum/maximum shift length, no mandatory break" - i.e. a
no-op, not a blocking constraint) applied per-field when that type's lookup
comes back not-found. A `definition_json` that fails to parse as the
expected shape (a tenant's own data-entry mistake, not a platform bug) logs
a warning and falls back to that field's platform default too, rather than
failing the whole solve - consistent with this module's own established
"never block auto-scheduling over a data problem this module didn't cause"
posture (contrast with hard-constraint enforcement itself, which is never
downgraded - this is about *sourcing* the constraint's own parameters, not
about whether the constraint gets enforced once sourced).

## Decision 5: a transient gRPC failure retries the specific call, up to 3 retries with exponential backoff; exhausting retries fails the request before any `ScheduleJob` is persisted
§4.3: "a transient gRPC failure mid-solve should retry the specific data
call, not abort the whole solve job." Implemented as a small shared
`app/grpc_clients/retry.py` helper: up to 4 attempts total per call (1
initial + 3 retries), backoff 100ms/400ms/1600ms between them, retrying
only on `UNAVAILABLE`/`DEADLINE_EXCEEDED`
(genuinely transient) - never on `INVALID_ARGUMENT`/`NOT_FOUND`/etc. (a
retry can't fix a malformed request). Since solving is still fully
synchronous inside the HTTP request (ADR-0055/Phase 2's already-flagged gap,
unchanged until Phase 7/8), a pull failure after retries are exhausted
raises `UpstreamDataUnavailableError` (503, retryable) **before any
`ScheduleJob`/`IdempotencyKey` row is created** - the same "the rejected
submission's transaction rolled back entirely" posture Phase 2's own
`InvalidShiftDefinitionError` test already established, not a new pattern.
A client retrying the identical `POST` with the same `Idempotency-Key`
after the upstream recovers behaves as a fresh attempt, not a replay of a
failure.

## Consequences
- `forecasting-service` gains its first gRPC surface, its first `grpcio`
  dependency, and a `main.py` change to boot a `grpc.aio.Server` alongside
  the existing FastAPI app (mirroring Module 01/02's own
  `connectMicroservice` pattern, adapted to Python's async stack). Verified
  directly, in isolation, against real Postgres - **not** through the full
  `app.main`/`TestClient(app)` path, since `app.main` transitively imports
  this service's full ML stack (`torch`/`ray`/`mlflow`/`lightgbm`/`prophet`/
  `pytorch-forecasting`/`lightning`), which this environment does not have
  installed and which installing was outside this phase's actual scope
  (rebuilding forecasting-service's ML environment, not the new gRPC
  surface). Flagged explicitly in the readiness checklist as a real,
  environment-specific verification gap, not silently worked around.
- `scheduling-service` gains a new `app/grpc_clients/` package (three thin
  clients + the shared retry helper) and `grpcio`/`grpcio-tools` as
  dependencies. Verified end-to-end against **real, running** Module 01/02
  (`src/`, the actual NestJS app, migrated and booted for real in this
  session) and the new `forecasting-service` gRPC server - not stubs, not a
  second fake implementation of the contract.
- `ScheduleJobRequest.roster`/`.policy`/`ShiftSlotInput.requiredHeadcount`
  becoming optional is a wire-compatible change (Pydantic fields with
  defaults) - every existing caller's request body continues to mean
  exactly what it meant before this phase.
